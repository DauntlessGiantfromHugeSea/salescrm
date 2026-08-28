import type { DraftType, MeetingSlot } from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { complete, completeJson } from './client.js';
import { buildDraftContext } from './context.js';
import {
  CLASSIFY_SYSTEM,
  DRAFT_OUTPUT_FORMAT,
  MEETING_SUMMARY_SYSTEM,
  draftSystemPrompt,
} from './prompts.js';
import { audit } from '../lib/audit.js';

interface DraftPayload {
  subject: string;
  body: string;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface GenerateDraftOptions {
  dealId: string;
  type: DraftType;
  userId: string;
  /** Zusätzliche Anweisung des Benutzers, z. B. "kürzer" oder "Termin vorschlagen". */
  instructions?: string;
  /** Terminvorschläge, die im Text erwähnt werden sollen. */
  slots?: MeetingSlot[];
}

/**
 * Erzeugt einen Mailentwurf und legt ihn im Status DRAFT ab.
 *
 * Der Entwurf wird nie versendet – er wartet auf die Freigabe im Dashboard.
 * Das ist die zentrale Zusage der Spezifikation (Kapitel 10.2).
 */
export async function generateDraft(options: GenerateDraftOptions): Promise<{ id: string }> {
  const context = await buildDraftContext(options.dealId);

  const parts = [context.text, '\n---\n', DRAFT_OUTPUT_FORMAT];

  if (options.slots?.length) {
    const formatted = options.slots
      .map((s) => `- ${formatSlot(s)}`)
      .join('\n');
    parts.push(
      `\nBiete im Text genau diese Termine an, in genau dieser Formulierung der Zeiten:\n${formatted}\n` +
        'Nenne sie als Vorschlag, nicht als gesetzt. Verweise darauf, dass der Termin als Teams-Besprechung stattfindet.',
    );
  }

  if (options.instructions) {
    parts.push(`\nZusätzliche Anweisung des Bearbeiters (hat Vorrang):\n${options.instructions}`);
  }

  const { data, model } = await completeJson<DraftPayload>({
    task: 'drafting',
    system: draftSystemPrompt(options.type),
    user: parts.join('\n'),
    maxTokens: 1200,
    temperature: 0.5,
  });

  if (!data.subject?.trim() || !data.body?.trim()) {
    throw new Error('Das Modell hat einen unvollständigen Entwurf geliefert');
  }

  const draft = await prisma.emailDraft.create({
    data: {
      dealId: options.dealId,
      userId: options.userId,
      type: options.type,
      status: 'DRAFT',
      subject: data.subject.trim().slice(0, 300),
      body: data.body.trim(),
      toEmail: context.contactEmail,
      toName: context.contactName,
      model,
      rationale: [data.rationale, confidenceNote(data.confidence)].filter(Boolean).join(' '),
      proposedSlots: options.slots ? (options.slots as unknown as object) : undefined,
    },
    select: { id: true },
  });

  await audit({
    userId: options.userId,
    action: 'draft.generated',
    entityType: 'EmailDraft',
    entityId: draft.id,
    detail: { dealId: options.dealId, type: options.type, model, confidence: data.confidence },
  });

  logger.info({ draftId: draft.id, dealId: options.dealId, type: options.type }, 'Entwurf erzeugt');
  return draft;
}

/**
 * Eine niedrige Zuversicht des Modells ist eine Warnung an den Bearbeiter,
 * nicht ein Grund, den Entwurf zu verwerfen – er sieht ihn ohnehin vor dem Versand.
 */
function confidenceNote(confidence: DraftPayload['confidence']): string {
  if (confidence === 'low') {
    return 'Hinweis: dünne Faktenlage im Kontext – bitte inhaltlich besonders prüfen.';
  }
  if (confidence === 'medium') return 'Hinweis: Faktenlage teilweise dünn.';
  return '';
}

function formatSlot(slot: MeetingSlot): string {
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  const date = start.toLocaleDateString('de-DE', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Berlin',
  });
  const time = (d: Date): string =>
    d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  return `${date}, ${time(start)}–${time(end)} Uhr`;
}

interface ClassificationPayload {
  summary: string;
  replyExpected: boolean;
  sentiment: 'positive' | 'neutral' | 'negative';
  suggestedNextAction: string | null;
  isBusinessRelevant: boolean;
}

/**
 * Fasst eine E-Mail zusammen und schätzt ein, ob sie eine Antwort erwartet.
 * Läuft auf dem kleinen Modell – hohe Stückzahl, einfache Aufgabe.
 */
export async function classifyActivity(activityId: string): Promise<void> {
  const activity = await prisma.activity.findUnique({
    where: { id: activityId },
    select: {
      id: true,
      subject: true,
      bodyPreview: true,
      direction: true,
      occurredAt: true,
      dealId: true,
    },
  });
  if (!activity?.bodyPreview) return;

  const { data } = await completeJson<ClassificationPayload>({
    task: 'classify',
    system: CLASSIFY_SYSTEM,
    user: `E-Mail vom ${activity.occurredAt.toLocaleDateString('de-DE')}, Richtung: ${
      activity.direction === 'INBOUND' ? 'eingegangen' : 'von uns gesendet'
    }
Betreff: ${activity.subject ?? '(kein Betreff)'}

${activity.bodyPreview}

---
Gib ein JSON-Objekt zurück:
{
  "summary": "Zwei Sätze, was inhaltlich drinsteht",
  "replyExpected": true oder false – erwartet der Absender eine Reaktion?,
  "sentiment": "positive" | "neutral" | "negative",
  "suggestedNextAction": "Konkrete nächste Aktion oder null, wenn keine nötig ist",
  "isBusinessRelevant": true oder false – geht es um ein Projekt oder Geschäft? Newsletter und Automatikmails sind false
}`,
    maxTokens: 500,
    temperature: 0.1,
  });

  await prisma.activity.update({
    where: { id: activity.id },
    data: {
      summary: data.summary?.slice(0, 1000) ?? null,
      replyPending: activity.direction === 'OUTBOUND' ? data.replyExpected : false,
    },
  });

  // Vorschläge für die nächste Aktion füllen nur Lücken – ein vom Menschen
  // gesetzter Wert wird nie überschrieben (Kapitel 7).
  if (data.suggestedNextAction && activity.dealId) {
    await prisma.deal.updateMany({
      where: { id: activity.dealId, OR: [{ nextAction: null }, { nextAction: '' }] },
      data: { nextAction: data.suggestedNextAction.slice(0, 500) },
    });
  }
}

interface MeetingSummaryPayload {
  summary: string;
  decisions: string[];
  actionItems: Array<{ owner: string; task: string; due: string | null }>;
  nextAction: string | null;
}

/** Fasst ein Teams-Transkript zusammen und schreibt das Ergebnis an den Termin. */
export async function summarizeMeeting(meetingId: string): Promise<void> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { id: true, subject: true, startsAt: true, transcriptText: true, dealId: true, attendeeEmails: true },
  });
  if (!meeting?.transcriptText) return;

  const { data } = await completeJson<MeetingSummaryPayload>({
    task: 'drafting',
    system: MEETING_SUMMARY_SYSTEM,
    user: `Besprechung: ${meeting.subject}
Datum: ${meeting.startsAt.toLocaleDateString('de-DE')}
Externe Teilnehmer: ${meeting.attendeeEmails.join(', ') || 'unbekannt'}

Transkript:
${meeting.transcriptText.slice(0, 60_000)}

---
Gib ein JSON-Objekt zurück:
{
  "summary": "Fließtext, 5 bis 10 Sätze: worum ging es, was war das Ergebnis",
  "decisions": ["Getroffene Entscheidungen, je eine pro Eintrag"],
  "actionItems": [{ "owner": "Name der zuständigen Person", "task": "Was zu tun ist", "due": "Frist als Text oder null" }],
  "nextAction": "Die eine nächste Aktion auf unserer Seite, oder null"
}`,
    maxTokens: 2000,
    temperature: 0.2,
  });

  const parts = [data.summary];
  if (data.decisions?.length) {
    parts.push('\nEntscheidungen:', ...data.decisions.map((d) => `• ${d}`));
  }
  if (data.actionItems?.length) {
    parts.push(
      '\nAufgaben:',
      ...data.actionItems.map(
        (a) => `• ${a.owner}: ${a.task}${a.due ? ` (bis ${a.due})` : ''}`,
      ),
    );
  }
  const summaryText = parts.join('\n');

  await prisma.meeting.update({
    where: { id: meeting.id },
    data: { summary: summaryText, nextActionSuggestion: data.nextAction },
  });

  // Das Besprechungsergebnis gehört in die Historie des Vorgangs.
  if (meeting.dealId) {
    await prisma.activity.create({
      data: {
        occurredAt: meeting.startsAt,
        direction: 'INTERNAL',
        channel: 'MEETING',
        subject: `Besprechungsnotiz: ${meeting.subject}`,
        summary: summaryText.slice(0, 4000),
        dealId: meeting.dealId,
        meetingId: meeting.id,
      },
    });

    if (data.nextAction) {
      await prisma.deal.updateMany({
        where: { id: meeting.dealId, OR: [{ nextAction: null }, { nextAction: '' }] },
        data: { nextAction: data.nextAction.slice(0, 500) },
      });
    }
  }

  logger.info({ meetingId }, 'Besprechung zusammengefasst');
}

/**
 * Erzeugt ein Kurzprofil einer Firma aus dem vorhandenen Schriftwechsel.
 * Füllt das Custom Field aus Kapitel 6.1.
 */
export async function profileCompany(companyId: string): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      website: true,
      industry: true,
      contacts: {
        select: {
          activities: {
            where: { direction: 'INBOUND' },
            orderBy: { occurredAt: 'desc' },
            take: 5,
            select: { subject: true, bodyPreview: true },
          },
        },
        take: 5,
      },
    },
  });
  if (!company) return;

  const samples = company.contacts
    .flatMap((c) => c.activities)
    .map((a) => `Betreff: ${a.subject ?? '-'}\n${(a.bodyPreview ?? '').slice(0, 600)}`)
    .join('\n\n---\n\n');

  if (!samples.trim()) return;

  const result = await complete({
    task: 'classify',
    system: CLASSIFY_SYSTEM,
    user: `Firma: ${company.name}${company.website ? ` (${company.website})` : ''}

Auszüge aus dem Schriftwechsel mit dieser Firma:
${samples}

---
Schreibe in höchstens drei Sätzen, was diese Firma macht und in welchem Verhältnis sie zu uns steht.
Nur was aus den Auszügen hervorgeht. Ist die Grundlage zu dünn, antworte exakt mit: Unklar.`,
    maxTokens: 300,
    temperature: 0.2,
  });

  if (result.text.trim().toLowerCase().startsWith('unklar')) return;

  await prisma.company.update({
    where: { id: company.id },
    data: { profile: result.text.trim().slice(0, 2000) },
  });
}
