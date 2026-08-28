import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createMeetingSchema } from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { currentUser, requireUser } from '../auth/session.js';
import { cancelTeamsMeeting, createTeamsMeeting, fetchMeetingTranscript, suggestMeetingTimes } from '../graph/teams.js';
import { summarizeMeeting } from '../ai/drafts.js';
import { dealVisibilityFilter } from './helpers.js';

export async function meetingRoutes(app: FastifyInstance): Promise<void> {
  /** Terminvorschläge aus dem echten Kalender. */
  app.post('/api/meetings/suggest', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = z
      .object({
        attendeeEmails: z.array(z.string().email()).min(1).max(10),
        durationMinutes: z.number().int().min(15).max(240).default(30),
        earliest: z.string().datetime().optional(),
        latest: z.string().datetime().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });

    try {
      const slots = await suggestMeetingTimes({
        userId: user.id,
        attendeeEmails: parsed.data.attendeeEmails,
        durationMinutes: parsed.data.durationMinutes,
        earliest: parsed.data.earliest ? new Date(parsed.data.earliest) : undefined,
        latest: parsed.data.latest ? new Date(parsed.data.latest) : undefined,
        maxCandidates: 6,
      });
      return { slots };
    } catch (err) {
      logger.error({ err }, 'Terminvorschläge fehlgeschlagen');
      return reply.status(502).send({ error: 'graph_failed', message: 'Der Kalender ist gerade nicht erreichbar' });
    }
  });

  /** Legt einen Teams-Termin aus dem Deal heraus an. */
  app.post('/api/meetings', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = createMeetingSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const body = parsed.data;

    const visibility = await dealVisibilityFilter(user);
    const deal = await prisma.deal.findFirst({
      where: { AND: [{ id: body.dealId }, visibility] },
      select: { id: true, projectId: true },
    });
    if (!deal) return reply.status(404).send({ error: 'not_found' });

    const startsAt = new Date(body.startsAt);
    if (startsAt.getTime() < Date.now()) {
      return reply.status(400).send({ error: 'past_date', message: 'Der Termin liegt in der Vergangenheit' });
    }
    const endsAt = new Date(startsAt.getTime() + body.durationMinutes * 60_000);

    try {
      const meeting = await createTeamsMeeting({
        userId: user.id,
        dealId: deal.id,
        projectId: deal.projectId,
        subject: body.subject,
        startsAt,
        endsAt,
        attendeeEmails: body.attendeeEmails,
        agenda: body.agenda,
        sendInvitation: body.sendInvitation,
      });
      return reply.status(201).send({
        id: meeting.id,
        joinUrl: meeting.joinUrl,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      });
    } catch (err) {
      logger.error({ err, dealId: body.dealId }, 'Teams-Termin konnte nicht angelegt werden');
      return reply.status(502).send({
        error: 'graph_failed',
        message: 'Der Termin konnte nicht angelegt werden. Bitte Kalenderberechtigung prüfen.',
      });
    }
  });

  app.post('/api/meetings/:id/cancel', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const body = z.object({ comment: z.string().max(1000).optional() }).parse(request.body ?? {});

    const meeting = await prisma.meeting.findFirst({
      where: { id, ...(user.role === 'ADMIN' ? {} : { organizerId: user.id }) },
      select: { id: true },
    });
    if (!meeting) return reply.status(404).send({ error: 'not_found' });

    try {
      await cancelTeamsMeeting(user.id, id, body.comment);
      return { ok: true };
    } catch (err) {
      logger.error({ err, meetingId: id }, 'Termin konnte nicht abgesagt werden');
      return reply.status(502).send({ error: 'graph_failed' });
    }
  });

  /**
   * Holt Transkript und Zusammenfassung sofort ab, statt auf den stündlichen
   * Lauf zu warten – für den Fall, dass jemand direkt nach dem Gespräch
   * nachsehen will.
   */
  app.post('/api/meetings/:id/transcript', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };

    const meeting = await prisma.meeting.findFirst({
      where: { id, ...(user.role === 'ADMIN' ? {} : { organizerId: user.id }) },
      select: { id: true, endsAt: true, summary: true },
    });
    if (!meeting) return reply.status(404).send({ error: 'not_found' });
    if (meeting.endsAt.getTime() > Date.now()) {
      return reply.status(400).send({ error: 'not_finished', message: 'Der Termin läuft noch' });
    }

    const fetched = await fetchMeetingTranscript(id);
    if (!fetched) {
      return reply.status(404).send({
        error: 'no_transcript',
        message:
          'Für diesen Termin liegt kein Transkript vor. Die Aufzeichnung muss in Teams aktiviert gewesen sein, ' +
          'und Microsoft stellt Transkripte erst einige Minuten nach dem Gespräch bereit.',
      });
    }

    await summarizeMeeting(id);
    const updated = await prisma.meeting.findUnique({
      where: { id },
      select: { summary: true, nextActionSuggestion: true, transcriptFetchedAt: true },
    });

    return {
      summary: updated?.summary ?? null,
      nextActionSuggestion: updated?.nextActionSuggestion ?? null,
      transcriptFetchedAt: updated?.transcriptFetchedAt?.toISOString() ?? null,
    };
  });

  app.get('/api/meetings', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const query = z
      .object({
        upcoming: z.coerce.boolean().default(false),
        projectId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);

    const meetings = await prisma.meeting.findMany({
      where: {
        ...(user.role === 'ADMIN' ? {} : { organizerId: user.id }),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.upcoming ? { startsAt: { gte: new Date() }, status: 'SCHEDULED' as const } : {}),
      },
      orderBy: { startsAt: query.upcoming ? 'asc' : 'desc' },
      take: query.limit,
      select: {
        id: true,
        subject: true,
        startsAt: true,
        endsAt: true,
        status: true,
        joinUrl: true,
        attendeeEmails: true,
        summary: true,
        transcriptFetchedAt: true,
        deal: { select: { id: true, title: true } },
        project: { select: { id: true, number: true, name: true } },
      },
    });

    return {
      meetings: meetings.map((m) => ({
        id: m.id,
        subject: m.subject,
        startsAt: m.startsAt.toISOString(),
        endsAt: m.endsAt.toISOString(),
        status: m.status,
        joinUrl: m.joinUrl,
        attendees: m.attendeeEmails,
        summary: m.summary,
        transcriptFetchedAt: m.transcriptFetchedAt?.toISOString() ?? null,
        dealId: m.deal?.id ?? null,
        dealTitle: m.deal?.title ?? null,
        projectId: m.project?.id ?? null,
        projectNumber: m.project?.number ?? null,
      })),
    };
  });
}
