import { PROJECT_CONTACT_ROLE_LABELS, DEAL_STAGE_LABELS, PROJECT_STAGE_LABELS } from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { truncate } from '../domain/parsing.js';
import { contactDisplayName } from '../domain/upsert.js';

/**
 * Baut den Kontext, den die KI für einen Entwurf braucht.
 *
 * Zwei Regeln bestimmen den Zuschnitt:
 * 1. Nur echte Daten aus der Datenbank – die KI soll referieren, nicht erfinden.
 * 2. Begrenzte Menge – ein Modell, das 40 Mails sieht, greift die falsche heraus.
 */

const MAX_HISTORY_ITEMS = 8;
const MAX_HISTORY_CHARS = 900;

export interface DraftContext {
  text: string;
  contactEmail: string;
  contactName: string | null;
  dealTitle: string;
}

export async function buildDraftContext(dealId: string): Promise<DraftContext> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      company: true,
      contact: true,
      owner: { select: { displayName: true } },
      project: {
        include: {
          contacts: {
            include: { contact: true, company: true },
            orderBy: { role: 'asc' },
            take: 10,
          },
        },
      },
      activities: {
        orderBy: { occurredAt: 'desc' },
        take: MAX_HISTORY_ITEMS,
        select: {
          occurredAt: true,
          direction: true,
          channel: true,
          subject: true,
          summary: true,
          bodyPreview: true,
        },
      },
      meetings: {
        orderBy: { startsAt: 'desc' },
        take: 3,
        select: { subject: true, startsAt: true, status: true, summary: true },
      },
    },
  });

  if (!deal) throw new Error(`Deal ${dealId} nicht gefunden`);
  if (!deal.contact) throw new Error('Der Deal hat keinen Kontakt – ohne Empfänger kein Entwurf');

  const lines: string[] = [];

  lines.push('## Absender');
  lines.push(`Bearbeiter: ${deal.owner.displayName}`);

  lines.push('\n## Empfänger');
  lines.push(`Name: ${contactDisplayName(deal.contact)}`);
  if (deal.contact.position) lines.push(`Position: ${deal.contact.position}`);
  if (deal.contact.decisionMakerLevel !== 'UNKNOWN') {
    lines.push(
      `Rolle im Einkauf: ${deal.contact.decisionMakerLevel === 'DECISION_MAKER' ? 'Entscheider' : 'Beeinflusser'}`,
    );
  }

  if (deal.company) {
    lines.push('\n## Firma');
    lines.push(`Name: ${deal.company.name}`);
    if (deal.company.industry) lines.push(`Branche: ${deal.company.industry}`);
    if (deal.company.size) lines.push(`Größe: ${deal.company.size}`);
    if (deal.company.profile) lines.push(`Profil: ${truncate(deal.company.profile, 400)}`);
  }

  lines.push('\n## Vorgang');
  lines.push(`Titel: ${deal.title}`);
  lines.push(`Status: ${DEAL_STAGE_LABELS[deal.stage]}`);
  if (deal.serviceArea) lines.push(`Leistungsbereich: ${deal.serviceArea}`);
  if (deal.description) lines.push(`Beschreibung: ${truncate(deal.description, 500)}`);
  if (deal.nextAction) lines.push(`Geplante nächste Aktion: ${deal.nextAction}`);
  if (deal.lastOutboundAt) {
    lines.push(`Letzte eigene Nachricht: ${formatDate(deal.lastOutboundAt)} (${daysAgo(deal.lastOutboundAt)} Tage her)`);
  }
  if (deal.lastInboundAt) {
    lines.push(`Letzte Antwort des Kontakts: ${formatDate(deal.lastInboundAt)}`);
  } else {
    lines.push('Der Kontakt hat auf die letzte Nachricht nicht geantwortet.');
  }

  if (deal.project) {
    lines.push('\n## Bauprojekt');
    lines.push(`${deal.project.number} – ${deal.project.name}`);
    lines.push(`Phase: ${PROJECT_STAGE_LABELS[deal.project.stage]}`);
    if (deal.project.city) lines.push(`Ort: ${[deal.project.postalCode, deal.project.city].filter(Boolean).join(' ')}`);
    if (deal.project.description) lines.push(`Kurzbeschreibung: ${truncate(deal.project.description, 400)}`);

    const namedRoles = deal.project.contacts.filter((c) => !c.autoDetected || c.role !== 'OTHER');
    if (namedRoles.length > 0) {
      lines.push('Beteiligte:');
      for (const participant of namedRoles) {
        const role = PROJECT_CONTACT_ROLE_LABELS[participant.role];
        const company = participant.company?.name ? ` (${participant.company.name})` : '';
        lines.push(`- ${contactDisplayName(participant.contact)}${company}: ${role}`);
      }
    }
  }

  if (deal.meetings.length > 0) {
    lines.push('\n## Termine');
    for (const meeting of deal.meetings) {
      lines.push(`- ${formatDate(meeting.startsAt)}: ${meeting.subject} (${meeting.status})`);
      if (meeting.summary) lines.push(`  Ergebnis: ${truncate(meeting.summary, 400)}`);
    }
  }

  if (deal.activities.length > 0) {
    lines.push('\n## Bisheriger Schriftwechsel (neueste zuerst)');
    for (const activity of deal.activities) {
      const who = activity.direction === 'OUTBOUND' ? 'Wir' : 'Kontakt';
      const content = activity.summary ?? activity.bodyPreview ?? '';
      lines.push(
        `\n[${formatDate(activity.occurredAt)}] ${who} – ${activity.subject ?? 'ohne Betreff'}\n${truncate(content, MAX_HISTORY_CHARS)}`,
      );
    }
  } else {
    lines.push('\n## Bisheriger Schriftwechsel');
    lines.push('Es gab bisher keinen Kontakt.');
  }

  return {
    text: lines.join('\n'),
    contactEmail: deal.contact.email,
    contactName: contactDisplayName(deal.contact),
    dealTitle: deal.title,
  };
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function daysAgo(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 86400_000);
}
