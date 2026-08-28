import type { MeetingSlot } from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { createTeamsMeeting, freeSlotsFromOwnCalendar } from '../graph/teams.js';
import { upsertContact } from './upsert.js';
import { audit } from '../lib/audit.js';
import { backfillProjectActivities } from './projectLinking.js';

/**
 * Öffentliche Terminbuchung.
 *
 * Die Buchungsseite ist die einzige Route ohne Anmeldung. Deshalb gilt hier:
 * nichts vertrauen, was von außen kommt, und der Slot wird gegen den echten
 * Kalender geprüft, nicht gegen das, was der Browser behauptet.
 */

export class BookingError extends Error {
  constructor(readonly code: 'slot_taken' | 'invalid_slot' | 'link_inactive' | 'rate_limited', message: string) {
    super(message);
    this.name = 'BookingError';
  }
}

/** Buchbare Zeitfenster für einen öffentlichen Link. */
export async function availableSlots(slug: string): Promise<{
  link: { title: string; description: string | null; durationMinutes: number; ownerName: string };
  slots: MeetingSlot[];
}> {
  const link = await prisma.bookingLink.findUnique({
    where: { slug },
    include: { owner: { select: { id: true, displayName: true, timezone: true } } },
  });
  if (!link || !link.active) throw new BookingError('link_inactive', 'Dieser Buchungslink ist nicht aktiv');

  const earliest = new Date(Date.now() + link.minNoticeHours * 3600_000);
  const latest = new Date(Date.now() + link.maxDaysAhead * 86400_000);

  const slots = await freeSlotsFromOwnCalendar({
    userId: link.ownerId,
    durationMinutes: link.durationMinutes,
    earliest,
    latest,
    maxCandidates: 30,
    workdayStart: link.workdayStart,
    workdayEnd: link.workdayEnd,
    weekdays: link.weekdays,
    timezone: link.owner.timezone,
  });

  // Bereits gebuchte, noch nicht im Kalender sichtbare Slots herausnehmen.
  const pending = await prisma.booking.findMany({
    where: { linkId: link.id, cancelledAt: null, startsAt: { gte: earliest } },
    select: { startsAt: true, endsAt: true },
  });

  const free = slots.filter(
    (slot) =>
      !pending.some(
        (b) =>
          new Date(slot.start).getTime() < b.endsAt.getTime() &&
          new Date(slot.end).getTime() > b.startsAt.getTime(),
      ),
  );

  return {
    link: {
      title: link.title,
      description: link.description,
      durationMinutes: link.durationMinutes,
      ownerName: link.owner.displayName,
    },
    slots: free,
  };
}

export interface BookingRequest {
  slug: string;
  start: Date;
  name: string;
  email: string;
  company?: string;
  note?: string;
  ip?: string;
}

/**
 * Nimmt eine Buchung an: Teams-Termin anlegen, Kontakt anlegen, Deal erzeugen.
 *
 * Der gebuchte Slot wird noch einmal gegen die tatsächlich freien Zeiten
 * geprüft. Ohne diese Prüfung könnte jemand mit einem manipulierten Request
 * einen beliebigen Termin in den Kalender schreiben.
 */
export async function createBooking(request: BookingRequest): Promise<{
  bookingId: string;
  joinUrl: string | null;
  startsAt: Date;
  endsAt: Date;
}> {
  const link = await prisma.bookingLink.findUnique({
    where: { slug: request.slug },
    include: { owner: { select: { id: true, displayName: true, timezone: true } } },
  });
  if (!link || !link.active) throw new BookingError('link_inactive', 'Dieser Buchungslink ist nicht aktiv');

  await enforceRateLimit(request.email, request.ip);

  const { slots } = await availableSlots(request.slug);
  const requestedStart = request.start.getTime();
  const slot = slots.find((s) => new Date(s.start).getTime() === requestedStart);
  if (!slot) {
    throw new BookingError('slot_taken', 'Dieser Termin ist nicht mehr verfügbar. Bitte wählen Sie einen anderen.');
  }

  const startsAt = new Date(slot.start);
  const endsAt = new Date(slot.end);

  const contact = await upsertContact({
    email: request.email,
    displayName: request.name,
    companyName: request.company ?? null,
    ownerId: link.ownerId,
    source: 'BOOKING',
  });
  if (!contact) throw new BookingError('invalid_slot', 'Diese E-Mail-Adresse kann nicht verwendet werden');

  // Ein bestehender offener Deal wird weitergeführt statt einen zweiten anzulegen.
  const existingDeal = await prisma.deal.findFirst({
    where: { contactId: contact.id, stage: { notIn: ['WON', 'LOST'] } },
    select: { id: true, projectId: true },
    orderBy: { updatedAt: 'desc' },
  });

  const deal =
    existingDeal ??
    (await prisma.deal.create({
      data: {
        title: `Terminanfrage: ${request.company ?? request.name}`,
        description: request.note ?? null,
        stage: 'MEETING_SCHEDULED',
        source: 'BOOKING',
        ownerId: link.ownerId,
        contactId: contact.id,
        companyId: contact.companyId,
        nextAction: 'Gespräch führen und Bedarf aufnehmen',
        lastContactAt: new Date(),
      },
      select: { id: true, projectId: true },
    }));

  const meeting = await createTeamsMeeting({
    userId: link.ownerId,
    dealId: deal.id,
    projectId: deal.projectId,
    subject: `${link.title} – ${request.company ?? request.name}`,
    startsAt,
    endsAt,
    attendeeEmails: [request.email],
    agenda: buildAgenda(request),
    sendInvitation: true,
  });

  const booking = await prisma.booking.create({
    data: {
      linkId: link.id,
      meetingId: meeting.id,
      dealId: deal.id,
      name: request.name,
      email: request.email.toLowerCase(),
      companyName: request.company ?? null,
      note: request.note ?? null,
      startsAt,
      endsAt,
      requesterIp: request.ip ?? null,
    },
    select: { id: true },
  });

  await audit({
    userId: link.ownerId,
    action: 'booking.created',
    entityType: 'Booking',
    entityId: booking.id,
    detail: { email: request.email, startsAt: startsAt.toISOString(), slug: request.slug },
    ip: request.ip,
  });

  // Wenn der Deal an einem Projekt hängt, gehört die Buchung in dessen Historie.
  if (deal.projectId) {
    void backfillProjectActivities(deal.projectId, { limit: 50 }).catch((err) =>
      logger.warn({ err }, 'Nachzuordnung nach Buchung fehlgeschlagen'),
    );
  }

  logger.info({ bookingId: booking.id, slug: request.slug }, 'Termin gebucht');
  return { bookingId: booking.id, joinUrl: meeting.joinUrl, startsAt, endsAt };
}

/**
 * Einfache Missbrauchsbremse für die öffentliche Route:
 * pro Adresse und pro IP eine begrenzte Zahl von Buchungen am Tag.
 */
async function enforceRateLimit(email: string, ip: string | undefined): Promise<void> {
  const since = new Date(Date.now() - 86400_000);

  const byEmail = await prisma.booking.count({
    where: { email: email.toLowerCase(), createdAt: { gte: since } },
  });
  if (byEmail >= 3) {
    throw new BookingError('rate_limited', 'Zu viele Buchungen mit dieser Adresse. Bitte melden Sie sich direkt bei uns.');
  }

  if (ip) {
    const byIp = await prisma.booking.count({ where: { requesterIp: ip, createdAt: { gte: since } } });
    if (byIp >= 10) {
      throw new BookingError('rate_limited', 'Zu viele Anfragen. Bitte versuchen Sie es später erneut.');
    }
  }
}

function buildAgenda(request: BookingRequest): string {
  const lines = [`Terminanfrage über die Website.`, ``, `Name: ${request.name}`, `E-Mail: ${request.email}`];
  if (request.company) lines.push(`Firma: ${request.company}`);
  if (request.note) lines.push(``, `Anliegen:`, request.note);
  return lines.join('\n');
}

/** Erzeugt einen URL-tauglichen Slug aus einem Titel. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
