import type { MeetingSlot } from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { GraphError, graphPaginate, graphRequest } from './client.js';
import type {
  GraphEvent,
  GraphMeetingTimeSuggestion,
  GraphOnlineMeeting,
  GraphScheduleInformation,
  GraphTranscript,
} from './types.js';
import { getAccessToken } from '../auth/tokenStore.js';
import { audit } from '../lib/audit.js';

/**
 * Teams-Besprechungen.
 *
 * Termine werden immer im Namen des Bearbeiters angelegt, nie mit der
 * Anwendungsidentität: der Kunde soll eine Einladung von einer echten Person
 * bekommen, und der Termin muss im Kalender dieser Person stehen.
 */

export interface CreateTeamsMeetingInput {
  userId: string;
  dealId: string | null;
  projectId?: string | null;
  subject: string;
  startsAt: Date;
  endsAt: Date;
  attendeeEmails: string[];
  agenda?: string;
  /** Einladung an die Teilnehmer verschicken? Bei Buchungen immer true. */
  sendInvitation?: boolean;
}

export interface CreatedMeeting {
  id: string;
  joinUrl: string | null;
  graphEventId: string;
}

/**
 * Legt einen Kalendereintrag mit Teams-Link an.
 *
 * Der Weg über `/me/events` mit `isOnlineMeeting: true` ist der zuverlässige:
 * Graph erzeugt die Onlinebesprechung dabei selbst und hängt sie an den Termin.
 * Der separate `/me/onlineMeetings`-Endpunkt erzeugt dagegen eine Besprechung
 * ohne Kalendereintrag – das führt regelmäßig zu Terminen, die niemand sieht.
 */
export async function createTeamsMeeting(input: CreateTeamsMeetingInput): Promise<CreatedMeeting> {
  const event = await graphRequest<GraphEvent & { onlineMeeting?: { joinUrl?: string } }>(
    input.userId,
    `/me/events?sendUpdates=${input.sendInvitation === false ? 'none' : 'all'}`,
    {
      method: 'POST',
      body: {
        subject: input.subject,
        body: {
          contentType: 'HTML',
          content: buildAgendaHtml(input.agenda),
        },
        start: { dateTime: toGraphDateTime(input.startsAt), timeZone: 'UTC' },
        end: { dateTime: toGraphDateTime(input.endsAt), timeZone: 'UTC' },
        attendees: input.attendeeEmails.map((email) => ({
          emailAddress: { address: email },
          type: 'required',
        })),
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
        allowNewTimeProposals: true,
      },
    },
  );

  const joinUrl = event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl ?? null;

  const meeting = await prisma.meeting.create({
    data: {
      dealId: input.dealId,
      projectId: input.projectId ?? null,
      organizerId: input.userId,
      subject: input.subject,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: 'SCHEDULED',
      attendeeEmails: input.attendeeEmails,
      agenda: input.agenda ?? null,
      graphEventId: event.id,
      joinUrl,
    },
    select: { id: true },
  });

  // Ein vereinbarter Termin ändert den Deal-Status – das ist eine der wenigen
  // Regeln, die das System selbst anwenden darf, weil sie eindeutig ist.
  if (input.dealId) {
    await prisma.deal.update({
      where: { id: input.dealId },
      data: { stage: 'MEETING_SCHEDULED', followUpDate: input.startsAt },
    });
    await prisma.activity.create({
      data: {
        occurredAt: new Date(),
        direction: 'OUTBOUND',
        channel: 'MEETING',
        subject: `Teams-Termin vereinbart: ${input.subject}`,
        summary: `Termin am ${formatDateTime(input.startsAt)} mit ${input.attendeeEmails.join(', ')}.`,
        dealId: input.dealId,
        projectId: input.projectId ?? null,
        meetingId: meeting.id,
        userId: input.userId,
      },
    });
  }

  if (input.projectId) {
    await prisma.project.update({
      where: { id: input.projectId },
      data: { lastActivityAt: new Date() },
    });
  }

  await audit({
    userId: input.userId,
    action: 'meeting.created',
    entityType: 'Meeting',
    entityId: meeting.id,
    detail: { subject: input.subject, attendees: input.attendeeEmails, startsAt: input.startsAt.toISOString() },
  });

  logger.info({ meetingId: meeting.id, joinUrl: Boolean(joinUrl) }, 'Teams-Termin angelegt');
  return { id: meeting.id, joinUrl, graphEventId: event.id };
}

export async function cancelTeamsMeeting(userId: string, meetingId: string, comment?: string): Promise<void> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { id: true, graphEventId: true, dealId: true },
  });
  if (!meeting?.graphEventId) throw new Error('Termin nicht gefunden oder nicht mit dem Kalender verbunden');

  await graphRequest(userId, `/me/events/${meeting.graphEventId}/cancel`, {
    method: 'POST',
    body: { comment: comment ?? 'Der Termin muss leider entfallen.' },
    tolerateNotFound: true,
  });

  await prisma.meeting.update({ where: { id: meeting.id }, data: { status: 'CANCELLED' } });
  await audit({ userId, action: 'meeting.cancelled', entityType: 'Meeting', entityId: meeting.id });
}

/**
 * Terminvorschläge aus dem echten Kalender.
 *
 * `findMeetingTimes` berücksichtigt Verfügbarkeit aller Teilnehmer, nicht nur
 * die eigene – deshalb ist es der Umfrage über `getSchedule` vorzuziehen,
 * sobald externe Adressen im Tenant sichtbar sind.
 */
export async function suggestMeetingTimes(input: {
  userId: string;
  attendeeEmails: string[];
  durationMinutes: number;
  earliest?: Date;
  latest?: Date;
  maxCandidates?: number;
}): Promise<MeetingSlot[]> {
  const earliest = input.earliest ?? nextBusinessStart();
  const latest = input.latest ?? new Date(earliest.getTime() + 14 * 86400_000);

  try {
    const response = await graphRequest<{ meetingTimeSuggestions?: GraphMeetingTimeSuggestion[] }>(
      input.userId,
      '/me/findMeetingTimes',
      {
        method: 'POST',
        headers: { Prefer: 'outlook.timezone="Europe/Berlin"' },
        body: {
          attendees: input.attendeeEmails.map((email) => ({
            type: 'required',
            emailAddress: { address: email },
          })),
          timeConstraint: {
            activityDomain: 'work',
            timeSlots: [
              {
                start: { dateTime: toGraphDateTime(earliest), timeZone: 'UTC' },
                end: { dateTime: toGraphDateTime(latest), timeZone: 'UTC' },
              },
            ],
          },
          meetingDuration: `PT${input.durationMinutes}M`,
          maxCandidates: input.maxCandidates ?? 5,
          // Externe Teilnehmer haben oft keine sichtbare Verfügbarkeit;
          // ohne diese Schwelle liefert Graph dann gar keine Vorschläge.
          minimumAttendeePercentage: 50,
          returnSuggestionReasons: false,
        },
      },
    );

    const suggestions = response.meetingTimeSuggestions ?? [];
    if (suggestions.length > 0) {
      return suggestions
        .map((s) => ({
          start: parseGraphSlotDate(s.meetingTimeSlot?.start),
          end: parseGraphSlotDate(s.meetingTimeSlot?.end),
          confidence: Math.round(s.confidence ?? 0),
        }))
        .filter((s): s is MeetingSlot => Boolean(s.start && s.end))
        .slice(0, input.maxCandidates ?? 5);
    }
  } catch (err) {
    logger.warn({ err }, 'findMeetingTimes lieferte kein Ergebnis – Rückfall auf eigenen Kalender');
  }

  // Rückfall: nur die eigene Verfügbarkeit auswerten. Besser ein Vorschlag,
  // der beim Bearbeiter passt, als gar keiner.
  return freeSlotsFromOwnCalendar({
    userId: input.userId,
    durationMinutes: input.durationMinutes,
    earliest,
    latest,
    maxCandidates: input.maxCandidates ?? 5,
  });
}

/**
 * Freie Zeitfenster im eigenen Kalender.
 * Wird auch von der öffentlichen Buchungsseite benutzt, wo es gar keine
 * Teilnehmerverfügbarkeit gibt, die man abfragen könnte.
 */
export async function freeSlotsFromOwnCalendar(input: {
  userId: string;
  durationMinutes: number;
  earliest: Date;
  latest: Date;
  maxCandidates: number;
  workdayStart?: string;
  workdayEnd?: string;
  weekdays?: number[];
  timezone?: string;
}): Promise<MeetingSlot[]> {
  const mailbox = await prisma.msAccount.findUnique({
    where: { userId: input.userId },
    select: { mailboxAddress: true },
  });
  if (!mailbox?.mailboxAddress) return [];

  const response = await graphRequest<{ value?: GraphScheduleInformation[] }>(
    input.userId,
    '/me/calendar/getSchedule',
    {
      method: 'POST',
      body: {
        schedules: [mailbox.mailboxAddress],
        startTime: { dateTime: toGraphDateTime(input.earliest), timeZone: 'UTC' },
        endTime: { dateTime: toGraphDateTime(input.latest), timeZone: 'UTC' },
        availabilityViewInterval: 30,
      },
    },
  );

  const busy = (response.value?.[0]?.scheduleItems ?? [])
    .filter((item) => item.status !== 'free')
    .map((item) => ({
      start: parseGraphSlotDate(item.start),
      end: parseGraphSlotDate(item.end),
    }))
    .filter((b): b is { start: string; end: string } => Boolean(b.start && b.end))
    .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }));

  return buildFreeSlots({
    busy,
    durationMinutes: input.durationMinutes,
    earliest: input.earliest,
    latest: input.latest,
    maxCandidates: input.maxCandidates,
    workdayStart: input.workdayStart ?? '09:00',
    workdayEnd: input.workdayEnd ?? '17:00',
    weekdays: input.weekdays ?? [1, 2, 3, 4, 5],
    timezone: input.timezone ?? 'Europe/Berlin',
  });
}

/**
 * Rechnet aus belegten Zeiten die buchbaren Fenster aus.
 * Reine Funktion – deshalb testbar ohne Graph.
 */
export function buildFreeSlots(input: {
  busy: Array<{ start: number; end: number }>;
  durationMinutes: number;
  earliest: Date;
  latest: Date;
  maxCandidates: number;
  workdayStart: string;
  workdayEnd: string;
  weekdays: number[];
  timezone: string;
}): MeetingSlot[] {
  const durationMs = input.durationMinutes * 60_000;
  const stepMs = 30 * 60_000;
  const slots: MeetingSlot[] = [];

  const busy = [...input.busy].sort((a, b) => a.start - b.start);

  // Auf die nächste halbe Stunde aufrunden – krumme Terminzeiten wirken unseriös.
  let cursor = Math.ceil(input.earliest.getTime() / stepMs) * stepMs;
  const end = input.latest.getTime();

  while (cursor + durationMs <= end && slots.length < input.maxCandidates) {
    const slotStart = new Date(cursor);
    const slotEnd = new Date(cursor + durationMs);

    if (
      isWithinWorkingHours(slotStart, slotEnd, input) &&
      !overlapsBusy(cursor, cursor + durationMs, busy)
    ) {
      slots.push({
        start: slotStart.toISOString(),
        end: slotEnd.toISOString(),
        confidence: 100,
      });
      // Nach einem Treffer einen ganzen Block überspringen, damit die
      // Vorschläge über den Tag verteilt sind statt im Halbstundentakt zu kleben.
      cursor += Math.max(durationMs, 2 * stepMs);
      continue;
    }
    cursor += stepMs;
  }

  return slots;
}

function overlapsBusy(start: number, end: number, busy: Array<{ start: number; end: number }>): boolean {
  return busy.some((b) => start < b.end && end > b.start);
}

function isWithinWorkingHours(
  start: Date,
  end: Date,
  config: { workdayStart: string; workdayEnd: string; weekdays: number[]; timezone: string },
): boolean {
  const local = localParts(start, config.timezone);
  const localEnd = localParts(end, config.timezone);

  // Termine dürfen nicht über Tagesgrenzen laufen.
  if (local.dateKey !== localEnd.dateKey) return false;
  if (!config.weekdays.includes(local.weekday)) return false;

  const startMinutes = local.hour * 60 + local.minute;
  const endMinutes = localEnd.hour * 60 + localEnd.minute;
  return startMinutes >= toMinutes(config.workdayStart) && endMinutes <= toMinutes(config.workdayEnd);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Zerlegt ein Datum in die lokalen Bestandteile einer Zeitzone.
 * Nötig, weil Arbeitszeiten lokal gelten, Termine aber in UTC gerechnet werden –
 * und die Sommerzeit sonst zweimal im Jahr für falsche Vorschläge sorgt.
 */
function localParts(
  date: Date,
  timezone: string,
): { weekday: number; hour: number; minute: number; dateKey: string } {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

  return {
    weekday: weekdayMap[parts.weekday ?? ''] ?? 1,
    hour: Number(parts.hour ?? '0'),
    minute: Number(parts.minute ?? '0'),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * Holt das Transkript einer abgelaufenen Besprechung.
 *
 * Der Inhalt liegt hinter einer eigenen URL, die einen normalen Bearer-Token
 * braucht, aber kein JSON zurückgibt – deshalb hier ein direkter fetch statt
 * des Graph-Helfers.
 */
export async function fetchMeetingTranscript(meetingId: string): Promise<boolean> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true,
      organizerId: true,
      graphOnlineMeetingId: true,
      joinUrl: true,
      transcriptFetchedAt: true,
      endsAt: true,
    },
  });
  if (!meeting) return false;
  if (meeting.transcriptFetchedAt) return true;
  if (meeting.endsAt.getTime() > Date.now()) return false;

  const onlineMeetingId = meeting.graphOnlineMeetingId ?? (await resolveOnlineMeetingId(meeting));
  if (!onlineMeetingId) return false;

  try {
    const transcripts: GraphTranscript[] = [];
    for await (const item of graphPaginate<GraphTranscript>(
      meeting.organizerId,
      `/me/onlineMeetings/${onlineMeetingId}/transcripts`,
      { maxItems: 5, beta: true },
    )) {
      transcripts.push(item);
    }
    if (transcripts.length === 0) return false;

    const latest = transcripts[transcripts.length - 1]!;
    const token = await getAccessToken(meeting.organizerId);
    const url = `https://graph.microsoft.com/beta/me/onlineMeetings/${onlineMeetingId}/transcripts/${latest.id}/content?$format=text/vtt`;

    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      logger.warn({ status: response.status, meetingId }, 'Transkriptinhalt nicht abrufbar');
      return false;
    }

    const vtt = await response.text();
    const text = vttToPlainText(vtt);
    if (!text.trim()) return false;

    await prisma.meeting.update({
      where: { id: meeting.id },
      data: {
        transcriptText: text.slice(0, 200_000),
        transcriptFetchedAt: new Date(),
        graphOnlineMeetingId: onlineMeetingId,
        status: 'HELD',
      },
    });

    logger.info({ meetingId, chars: text.length }, 'Transkript abgeholt');
    return true;
  } catch (err) {
    if (err instanceof GraphError && err.isPermissionDenied) {
      logger.warn({ meetingId }, 'Transkript-Berechtigung fehlt – Auswertung übersprungen');
      return false;
    }
    logger.warn({ err, meetingId }, 'Transkript konnte nicht geholt werden');
    return false;
  }
}

/** Findet die Onlinebesprechung anhand der Join-URL. */
async function resolveOnlineMeetingId(meeting: {
  organizerId: string;
  joinUrl: string | null;
}): Promise<string | null> {
  if (!meeting.joinUrl) return null;
  try {
    const response = await graphRequest<{ value?: GraphOnlineMeeting[] }>(
      meeting.organizerId,
      `/me/onlineMeetings?$filter=joinWebUrl eq '${meeting.joinUrl.replace(/'/g, "''")}'`,
    );
    return response.value?.[0]?.id ?? null;
  } catch (err) {
    logger.debug({ err }, 'Onlinebesprechung nicht auflösbar');
    return null;
  }
}

/**
 * Wandelt WebVTT in lesbaren Text.
 * Sprecherangaben bleiben erhalten – ohne sie ist eine Zusammenfassung
 * von "wer hat was zugesagt" wertlos.
 */
export function vttToPlainText(vtt: string): string {
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  let lastSpeaker = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === 'WEBVTT') continue;
    if (trimmed.includes('-->')) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(trimmed)) continue;

    // Sprecher stehen als <v Name>Text</v>.
    const speakerMatch = /^<v\s+([^>]+)>(.*?)(?:<\/v>)?$/.exec(trimmed);
    if (speakerMatch) {
      const speaker = speakerMatch[1]?.trim() ?? '';
      const text = speakerMatch[2]?.trim() ?? '';
      if (!text) continue;
      if (speaker === lastSpeaker) out.push(text);
      else {
        out.push(`\n${speaker}: ${text}`);
        lastSpeaker = speaker;
      }
      continue;
    }

    out.push(trimmed.replace(/<[^>]+>/g, ''));
  }

  return out.join(' ').replace(/\s*\n\s*/g, '\n').trim();
}

function buildAgendaHtml(agenda: string | undefined): string {
  if (!agenda) return '<p>Besprechung per Microsoft Teams.</p>';
  const escaped = agenda
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
}

/** Graph erwartet lokale Zeit ohne Zonensuffix; wir liefern konsequent UTC. */
function toGraphDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '');
}

function parseGraphSlotDate(value: { dateTime: string; timeZone: string } | undefined): string {
  if (!value?.dateTime) return '';
  const raw = value.dateTime;
  const iso = raw.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/** Nächster Werktagsbeginn – Startpunkt für Terminvorschläge. */
function nextBusinessStart(): Date {
  const date = new Date(Date.now() + 12 * 3600_000);
  date.setUTCMinutes(0, 0, 0);
  return date;
}

function formatDateTime(date: Date): string {
  return date.toLocaleString('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Berlin',
  });
}
