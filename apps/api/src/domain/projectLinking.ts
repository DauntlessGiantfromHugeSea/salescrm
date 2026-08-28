import {
  ACTIVE_PROJECT_STAGES,
  matchMailToProject,
  type MailMatchInput,
  type MatchResult,
  type ProjectCandidate,
} from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { emailDomain } from './parsing.js';

/**
 * Verbindet den reinen Zuordnungsalgorithmus aus dem Shared-Package mit der
 * Datenbank: Kandidaten laden, bewerten, Ergebnis schreiben oder zur Prüfung
 * vorlegen.
 */

/**
 * Kandidaten-Cache. Der Erstimport verarbeitet zehntausende Mails; ohne Cache
 * würde die Beteiligtenliste jedes Projekts pro Mail neu geladen.
 */
let candidateCache: { loadedAt: number; candidates: ProjectCandidate[] } | null = null;
const CACHE_TTL_MS = 60_000;

export function invalidateProjectCache(): void {
  candidateCache = null;
}

export async function loadProjectCandidates(force = false): Promise<ProjectCandidate[]> {
  if (!force && candidateCache && Date.now() - candidateCache.loadedAt < CACHE_TTL_MS) {
    return candidateCache.candidates;
  }

  const projects = await prisma.project.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      number: true,
      name: true,
      aliases: true,
      stage: true,
      contacts: {
        select: {
          contact: { select: { email: true } },
          company: { select: { emailDomain: true } },
        },
      },
      company: { select: { emailDomain: true } },
    },
  });

  const candidates: ProjectCandidate[] = projects.map((p) => {
    const emails = p.contacts.map((c) => c.contact.email.toLowerCase());
    const domains = new Set<string>();
    for (const c of p.contacts) {
      if (c.company?.emailDomain) domains.add(c.company.emailDomain.toLowerCase());
      const d = emailDomain(c.contact.email);
      if (d) domains.add(d);
    }
    if (p.company?.emailDomain) domains.add(p.company.emailDomain.toLowerCase());

    return {
      id: p.id,
      number: p.number,
      name: p.name,
      // Der Projektname selbst ist ein brauchbarer Alias, wenn er spezifisch genug ist.
      aliases: [...p.aliases, ...(p.name.length >= 8 ? [p.name] : [])],
      participantEmails: emails,
      participantDomains: [...domains],
      isActive: ACTIVE_PROJECT_STAGES.includes(p.stage),
    };
  });

  candidateCache = { loadedAt: Date.now(), candidates };
  return candidates;
}

export interface LinkMailInput {
  activityId: string;
  subject: string;
  bodyPreview: string;
  participantEmails: string[];
  conversationId: string | null;
  dealId: string | null;
  userId: string;
}

/**
 * Ordnet eine importierte Mail einem Projekt zu.
 *
 * Sichere Treffer werden direkt geschrieben. Unsichere oder mehrdeutige Fälle
 * landen als Prüfaufgabe in Bucket D – nichts wird geraten, das ist die
 * Grundregel aus Kapitel 4.3.
 */
export async function linkActivityToProject(input: LinkMailInput): Promise<MatchResult> {
  const candidates = await loadProjectCandidates();
  if (candidates.length === 0) {
    return { match: null, ranked: [], ambiguous: false };
  }

  const [conversationProjectId, dealProjectId] = await Promise.all([
    input.conversationId ? findConversationProject(input.conversationId) : Promise.resolve(null),
    input.dealId ? findDealProject(input.dealId) : Promise.resolve(null),
  ]);

  const matchInput: MailMatchInput = {
    subject: input.subject,
    bodyPreview: input.bodyPreview,
    participantEmails: input.participantEmails,
    conversationProjectId,
    dealProjectId,
  };

  const result = matchMailToProject(matchInput, candidates);

  if (result.match) {
    await prisma.$transaction([
      prisma.activity.update({
        where: { id: input.activityId },
        data: {
          projectId: result.match.projectId,
          projectLinkMethod: result.match.method,
          projectLinkScore: result.match.score,
        },
      }),
      prisma.project.update({
        where: { id: result.match.projectId },
        data: { lastActivityAt: new Date() },
      }),
    ]);
    return result;
  }

  if (result.ambiguous) {
    const top = result.ranked.slice(0, 3);
    const names = await prisma.project.findMany({
      where: { id: { in: top.map((t) => t.projectId) } },
      select: { id: true, number: true, name: true },
    });
    await upsertReview({
      type: 'AMBIGUOUS_PROJECT_MAIL',
      dedupeKey: `ambiguous-project:${input.activityId}`,
      title: `Mail passt zu mehreren Projekten: „${input.subject.slice(0, 80)}"`,
      detail:
        'Diese Mail lässt sich nicht eindeutig zuordnen. Infrage kommen: ' +
        names.map((n) => `${n.number} ${n.name}`).join(', ') +
        '. Bitte im Projekt-Tab manuell zuordnen.',
      userId: input.userId,
      projectId: top[0]?.projectId ?? null,
    });
  }

  return result;
}

async function findConversationProject(conversationId: string): Promise<string | null> {
  const prior = await prisma.activity.findFirst({
    where: { conversationId, projectId: { not: null } },
    select: { projectId: true },
    orderBy: { occurredAt: 'desc' },
  });
  return prior?.projectId ?? null;
}

async function findDealProject(dealId: string): Promise<string | null> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { projectId: true } });
  return deal?.projectId ?? null;
}

async function upsertReview(item: {
  type: 'AMBIGUOUS_PROJECT_MAIL' | 'UNASSIGNED_PROJECT_MAIL';
  dedupeKey: string;
  title: string;
  detail: string;
  userId: string;
  projectId: string | null;
}): Promise<void> {
  try {
    await prisma.reviewItem.upsert({
      where: { dedupeKey: item.dedupeKey },
      create: {
        type: item.type,
        dedupeKey: item.dedupeKey,
        title: item.title,
        detail: item.detail,
        userId: item.userId,
        projectId: item.projectId,
      },
      update: { detail: item.detail },
    });
  } catch (err) {
    logger.warn({ err, dedupeKey: item.dedupeKey }, 'Prüfaufgabe konnte nicht angelegt werden');
  }
}

/**
 * Pflegt die Beteiligtenliste eines Projekts aus dem Mailverkehr fort.
 *
 * Wer wiederholt in Projektmails auftaucht, wird als Beteiligter vorgeschlagen –
 * markiert als automatisch erkannt, damit im Dashboard sichtbar bleibt, was
 * gepflegt und was geraten ist. Die Rolle setzt weiterhin ein Mensch.
 */
export async function noteProjectParticipant(params: {
  projectId: string;
  contactId: string;
  occurredAt: Date;
}): Promise<void> {
  const existing = await prisma.projectContact.findUnique({
    where: { projectId_contactId: { projectId: params.projectId, contactId: params.contactId } },
    select: { id: true, lastContactAt: true },
  });

  if (existing) {
    if (!existing.lastContactAt || existing.lastContactAt < params.occurredAt) {
      await prisma.projectContact.update({
        where: { id: existing.id },
        data: { lastContactAt: params.occurredAt },
      });
    }
    return;
  }

  const contact = await prisma.contact.findUnique({
    where: { id: params.contactId },
    select: { companyId: true },
  });

  await prisma.projectContact.create({
    data: {
      projectId: params.projectId,
      contactId: params.contactId,
      companyId: contact?.companyId ?? null,
      role: 'OTHER',
      autoDetected: true,
      lastContactAt: params.occurredAt,
    },
  });
  invalidateProjectCache();
}

/**
 * Ordnet bereits importierte Mails nachträglich einem Projekt zu.
 * Wird aufgerufen, wenn ein Projekt neu angelegt oder ein Beteiligter
 * ergänzt wird – dann soll die vorhandene Historie sofort am Projekt hängen.
 */
export async function backfillProjectActivities(
  projectId: string,
  options: { limit?: number } = {},
): Promise<number> {
  const limit = options.limit ?? 2000;
  invalidateProjectCache();

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      number: true,
      createdAt: true,
      startsOn: true,
      contacts: { select: { contactId: true } },
    },
  });
  if (!project) return 0;

  const contactIds = project.contacts.map((c) => c.contactId);
  // Zeitliche Grenze: Mails, die deutlich vor dem Projektbeginn liegen,
  // gehören in aller Regel nicht dazu.
  const since = project.startsOn ?? new Date(project.createdAt.getTime() - 365 * 24 * 3600 * 1000);

  const activities = await prisma.activity.findMany({
    where: {
      projectId: null,
      channel: 'EMAIL',
      occurredAt: { gte: since },
      OR: [
        ...(contactIds.length > 0 ? [{ contactId: { in: contactIds } }] : []),
        { subject: { contains: project.number, mode: 'insensitive' as const } },
      ],
    },
    select: {
      id: true,
      subject: true,
      bodyPreview: true,
      conversationId: true,
      dealId: true,
      userId: true,
      contactId: true,
      occurredAt: true,
      contact: { select: { email: true } },
    },
    orderBy: { occurredAt: 'desc' },
    take: limit,
  });

  let linked = 0;
  for (const activity of activities) {
    const result = await linkActivityToProject({
      activityId: activity.id,
      subject: activity.subject ?? '',
      bodyPreview: activity.bodyPreview ?? '',
      participantEmails: activity.contact ? [activity.contact.email] : [],
      conversationId: activity.conversationId,
      dealId: activity.dealId,
      userId: activity.userId ?? '',
    });
    if (result.match?.projectId === projectId) linked++;
  }

  logger.info({ projectId, scanned: activities.length, linked }, 'Historie nachträglich zugeordnet');
  return linked;
}
