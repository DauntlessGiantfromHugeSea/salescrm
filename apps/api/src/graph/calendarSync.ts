import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { graphPaginate } from './client.js';
import type { GraphEvent } from './types.js';
import { isInternalAddress } from '../domain/upsert.js';
import { loadProjectCandidates } from '../domain/projectLinking.js';
import { matchMailToProject } from '@salescrm/shared';

/**
 * Spiegelt Kalendertermine, damit bestätigte Meetings die Follow-up-Regel
 * aussetzen (Kapitel 8: "Termin bereits bestätigt" ⇒ Deal nicht offen)
 * und damit Termine an Projekt und Deal sichtbar werden.
 */
export async function syncCalendar(
  userId: string,
  options: { daysBack?: number; daysAhead?: number } = {},
): Promise<{ processed: number; linked: number }> {
  const daysBack = options.daysBack ?? 30;
  const daysAhead = options.daysAhead ?? 90;

  const start = new Date(Date.now() - daysBack * 86400_000);
  const end = new Date(Date.now() + daysAhead * 86400_000);

  const path =
    `/me/calendarView?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}` +
    '&$select=id,subject,start,end,attendees,isOnlineMeeting,onlineMeeting,isCancelled,bodyPreview,webLink' +
    '&$orderby=start/dateTime&$top=100';

  let processed = 0;
  let linked = 0;

  for await (const event of graphPaginate<GraphEvent>(userId, path, { maxItems: 1000 })) {
    if (event['@removed']) continue;
    processed++;
    try {
      if (await ingestEvent(userId, event)) linked++;
    } catch (err) {
      logger.warn({ err, eventId: event.id }, 'Termin konnte nicht übernommen werden');
    }
  }

  await prisma.syncState.upsert({
    where: { userId_resource: { userId, resource: 'calendar' } },
    create: { userId, resource: 'calendar', lastRunAt: new Date(), itemsSynced: processed, backfillDone: true },
    update: { lastRunAt: new Date(), lastError: null, itemsSynced: { increment: processed } },
  });

  logger.info({ userId, processed, linked }, 'Kalender synchronisiert');
  return { processed, linked };
}

async function ingestEvent(userId: string, event: GraphEvent): Promise<boolean> {
  const startsAt = parseGraphDate(event.start);
  const endsAt = parseGraphDate(event.end);
  if (!startsAt || !endsAt) return false;

  const attendeeEmails = (event.attendees ?? [])
    .map((a) => a.emailAddress?.address?.toLowerCase().trim())
    .filter((a): a is string => Boolean(a));
  const externalAttendees = attendeeEmails.filter((a) => !isInternalAddress(a));

  // Interne Termine ohne externe Teilnehmer sind für die Akquise irrelevant.
  if (externalAttendees.length === 0) return false;

  const existing = await prisma.meeting.findUnique({
    where: { graphEventId: event.id },
    select: { id: true, dealId: true, projectId: true, status: true },
  });

  const status = event.isCancelled
    ? ('CANCELLED' as const)
    : endsAt.getTime() < Date.now()
      ? ('HELD' as const)
      : ('SCHEDULED' as const);

  const joinUrl = event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl ?? null;

  if (existing) {
    await prisma.meeting.update({
      where: { id: existing.id },
      data: {
        subject: event.subject ?? 'Termin',
        startsAt,
        endsAt,
        status,
        attendeeEmails: externalAttendees,
        joinUrl,
      },
    });
    if (existing.dealId) await markDealMeetingScheduled(existing.dealId, status, startsAt);
    return Boolean(existing.projectId);
  }

  // Zuordnung: erst Projekt über Betreff und Teilnehmer, dann Deal über den Kontakt.
  const projectId = await matchEventToProject(event, externalAttendees);
  const dealId = await findDealForAttendees(externalAttendees, projectId);

  await prisma.meeting.create({
    data: {
      graphEventId: event.id,
      organizerId: userId,
      subject: event.subject ?? 'Termin',
      startsAt,
      endsAt,
      status,
      attendeeEmails: externalAttendees,
      agenda: event.bodyPreview ?? null,
      joinUrl,
      dealId,
      projectId,
    },
  });

  if (dealId) await markDealMeetingScheduled(dealId, status, startsAt);
  if (projectId) {
    await prisma.project.update({ where: { id: projectId }, data: { lastActivityAt: startsAt } });
  }

  return Boolean(projectId);
}

/** Ein bestätigter künftiger Termin setzt den Deal auf "Termin vereinbart". */
async function markDealMeetingScheduled(
  dealId: string,
  status: 'SCHEDULED' | 'HELD' | 'CANCELLED',
  startsAt: Date,
): Promise<void> {
  if (status !== 'SCHEDULED' || startsAt.getTime() < Date.now()) return;
  const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { stage: true } });
  if (!deal) return;
  // Fortgeschrittene Stufen nicht zurückdrehen.
  if (['PROPOSAL_SENT', 'PROPOSAL_IN_PROGRESS', 'WON', 'LOST'].includes(deal.stage)) return;
  await prisma.deal.update({
    where: { id: dealId },
    data: { stage: 'MEETING_SCHEDULED', followUpDate: startsAt },
  });
}

async function matchEventToProject(
  event: GraphEvent,
  attendeeEmails: string[],
): Promise<string | null> {
  const candidates = await loadProjectCandidates();
  if (candidates.length === 0) return null;
  const result = matchMailToProject(
    {
      subject: event.subject ?? '',
      bodyPreview: event.bodyPreview ?? '',
      participantEmails: attendeeEmails,
    },
    candidates,
  );
  return result.match?.projectId ?? null;
}

async function findDealForAttendees(
  attendeeEmails: string[],
  projectId: string | null,
): Promise<string | null> {
  const contacts = await prisma.contact.findMany({
    where: { email: { in: attendeeEmails } },
    select: { id: true },
  });
  if (contacts.length === 0) return null;

  const deals = await prisma.deal.findMany({
    where: {
      contactId: { in: contacts.map((c) => c.id) },
      stage: { notIn: ['WON', 'LOST'] },
      ...(projectId ? { projectId } : {}),
    },
    select: { id: true },
    orderBy: { updatedAt: 'desc' },
    take: 2,
  });
  return deals.length === 1 ? deals[0]!.id : null;
}

/** Graph liefert Datum und Zeitzone getrennt; ohne Suffix interpretiert JS falsch. */
export function parseGraphDate(value: { dateTime: string; timeZone: string } | undefined): Date | null {
  if (!value?.dateTime) return null;
  const raw = value.dateTime;
  const iso = raw.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
