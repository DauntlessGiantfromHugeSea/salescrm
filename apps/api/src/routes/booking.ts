import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createBookingSchema } from '@salescrm/shared';
import { config } from '../config.js';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { BookingError, availableSlots, createBooking, slugify } from '../domain/booking.js';
import { currentUser, requireUser } from '../auth/session.js';
import { audit } from '../lib/audit.js';

/**
 * Öffentliche Buchungsseite.
 *
 * Die einzigen Routen des Systems ohne Anmeldung. Sie geben bewusst nur das
 * Nötigste preis: Titel, Dauer, Name des Ansprechpartners und freie Zeiten –
 * keine Kalenderinhalte, keine Kundendaten, keine Terminbetreffs.
 */
export async function bookingRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/public/booking/:slug',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      try {
        const result = await availableSlots(slug);
        return result;
      } catch (err) {
        if (err instanceof BookingError) {
          return reply.status(404).send({ error: err.code, message: err.message });
        }
        logger.error({ err, slug }, 'Buchungsseite konnte nicht geladen werden');
        return reply.status(502).send({
          error: 'calendar_unavailable',
          message: 'Die Termine können gerade nicht geladen werden. Bitte später erneut versuchen.',
        });
      }
    },
  );

  app.post(
    '/api/public/booking/:slug',
    {
      // Enge Grenze: diese Route legt echte Kalendereinträge an.
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const parsed = createBookingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }

      try {
        const result = await createBooking({
          slug,
          start: new Date(parsed.data.start),
          name: parsed.data.name,
          email: parsed.data.email,
          company: parsed.data.company,
          note: parsed.data.note,
          ip: request.ip,
        });
        return reply.status(201).send({
          startsAt: result.startsAt.toISOString(),
          endsAt: result.endsAt.toISOString(),
          joinUrl: result.joinUrl,
        });
      } catch (err) {
        if (err instanceof BookingError) {
          const status = err.code === 'rate_limited' ? 429 : err.code === 'slot_taken' ? 409 : 400;
          return reply.status(status).send({ error: err.code, message: err.message });
        }
        logger.error({ err, slug }, 'Buchung fehlgeschlagen');
        return reply.status(502).send({
          error: 'booking_failed',
          message: 'Der Termin konnte nicht angelegt werden. Bitte melden Sie sich direkt bei uns.',
        });
      }
    },
  );

  /* ---------- Verwaltung der Links (angemeldet) ---------- */

  app.get('/api/booking-links', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const links = await prisma.bookingLink.findMany({
      where: user.role === 'ADMIN' ? {} : { ownerId: user.id },
      include: { owner: { select: { displayName: true } }, _count: { select: { bookings: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      links: links.map((l) => ({
        id: l.id,
        slug: l.slug,
        title: l.title,
        description: l.description,
        durationMinutes: l.durationMinutes,
        minNoticeHours: l.minNoticeHours,
        maxDaysAhead: l.maxDaysAhead,
        workdayStart: l.workdayStart,
        workdayEnd: l.workdayEnd,
        weekdays: l.weekdays,
        active: l.active,
        ownerName: l.owner.displayName,
        bookingCount: l._count.bookings,
        url: `${config.PUBLIC_BASE_URL}/b/${l.slug}`,
      })),
    };
  });

  app.post('/api/booking-links', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = z
      .object({
        title: z.string().min(1).max(200),
        slug: z.string().max(60).optional(),
        description: z.string().max(2000).optional(),
        durationMinutes: z.number().int().min(15).max(240).default(30),
        minNoticeHours: z.number().int().min(0).max(336).default(12),
        maxDaysAhead: z.number().int().min(1).max(180).default(21),
        workdayStart: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
        workdayEnd: z.string().regex(/^\d{2}:\d{2}$/).default('17:00'),
        weekdays: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const body = parsed.data;

    const account = await prisma.msAccount.findUnique({ where: { userId: user.id }, select: { id: true } });
    if (!account) {
      return reply.status(400).send({
        error: 'no_mailbox',
        message: 'Ohne verbundenen Kalender können keine Termine gebucht werden',
      });
    }

    // Eindeutigen Slug finden, ohne den Benutzer mit einem Fehler zu behelligen.
    const base = slugify(body.slug ?? body.title) || 'termin';
    let slug = base;
    for (let i = 2; await prisma.bookingLink.findUnique({ where: { slug } }); i++) {
      slug = `${base}-${i}`;
    }

    const link = await prisma.bookingLink.create({
      data: {
        slug,
        ownerId: user.id,
        title: body.title,
        description: body.description ?? null,
        durationMinutes: body.durationMinutes,
        minNoticeHours: body.minNoticeHours,
        maxDaysAhead: body.maxDaysAhead,
        workdayStart: body.workdayStart,
        workdayEnd: body.workdayEnd,
        weekdays: body.weekdays,
      },
      select: { id: true, slug: true, title: true },
    });

    await audit({
      userId: user.id,
      action: 'booking_link.created',
      entityType: 'BookingLink',
      entityId: link.id,
      detail: { slug },
      ip: request.ip,
    });

    return reply.status(201).send({ ...link, url: `${config.PUBLIC_BASE_URL}/b/${link.slug}` });
  });

  app.patch('/api/booking-links/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        durationMinutes: z.number().int().min(15).max(240).optional(),
        minNoticeHours: z.number().int().min(0).max(336).optional(),
        maxDaysAhead: z.number().int().min(1).max(180).optional(),
        workdayStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        workdayEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        weekdays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
        active: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });

    const existing = await prisma.bookingLink.findFirst({
      where: { id, ...(user.role === 'ADMIN' ? {} : { ownerId: user.id }) },
      select: { id: true },
    });
    if (!existing) return reply.status(404).send({ error: 'not_found' });

    const link = await prisma.bookingLink.update({
      where: { id },
      data: parsed.data,
      select: { id: true, slug: true, active: true },
    });
    return link;
  });

  app.get('/api/booking-links/:id/bookings', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };

    const link = await prisma.bookingLink.findFirst({
      where: { id, ...(user.role === 'ADMIN' ? {} : { ownerId: user.id }) },
      select: { id: true },
    });
    if (!link) return reply.status(404).send({ error: 'not_found' });

    const bookings = await prisma.booking.findMany({
      where: { linkId: id },
      orderBy: { startsAt: 'desc' },
      take: 100,
      select: {
        id: true,
        name: true,
        email: true,
        companyName: true,
        note: true,
        startsAt: true,
        endsAt: true,
        cancelledAt: true,
        createdAt: true,
        deal: { select: { id: true, title: true } },
        meeting: { select: { id: true, joinUrl: true, status: true } },
      },
    });

    return {
      bookings: bookings.map((b) => ({
        ...b,
        startsAt: b.startsAt.toISOString(),
        endsAt: b.endsAt.toISOString(),
        cancelledAt: b.cancelledAt?.toISOString() ?? null,
        createdAt: b.createdAt.toISOString(),
      })),
    };
  });
}
