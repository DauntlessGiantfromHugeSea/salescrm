import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { approveDraftSchema, generateDraftSchema, updateDraftSchema } from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { currentUser, requireUser } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { generateDraft } from '../ai/drafts.js';
import { sendApprovedDraft } from '../graph/sendMail.js';
import { suggestMeetingTimes } from '../graph/teams.js';
import { dealVisibilityFilter } from './helpers.js';

/**
 * Entwürfe und Freigabe.
 *
 * Der gesamte Weg zum Versand ist bewusst zweistufig: erst freigeben, dann
 * senden. Kein Endpunkt erzeugt einen Entwurf und schickt ihn in einem Schritt.
 */
export async function draftRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/drafts', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const query = z
      .object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(request.query);

    const drafts = await prisma.emailDraft.findMany({
      where: {
        ...(user.role === 'ADMIN' ? {} : { userId: user.id }),
        status: query.status
          ? { in: query.status.split(',') as never }
          : { in: ['DRAFT', 'EDITED', 'APPROVED', 'FAILED'] },
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: {
        deal: {
          select: {
            id: true,
            title: true,
            stage: true,
            openReasons: true,
            company: { select: { name: true } },
            project: { select: { number: true, name: true } },
          },
        },
      },
    });

    return {
      drafts: drafts.map((d) => ({
        id: d.id,
        dealId: d.dealId,
        dealTitle: d.deal.title,
        dealStage: d.deal.stage,
        openReasons: d.deal.openReasons,
        companyName: d.deal.company?.name ?? null,
        projectNumber: d.deal.project?.number ?? null,
        projectName: d.deal.project?.name ?? null,
        type: d.type,
        status: d.status,
        subject: d.subject,
        body: d.body,
        toEmail: d.toEmail,
        toName: d.toName,
        ccEmails: d.ccEmails,
        model: d.model,
        rationale: d.rationale,
        proposedSlots: d.proposedSlots,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
        sentAt: d.sentAt?.toISOString() ?? null,
        error: d.error,
      })),
    };
  });

  /** Erzeugt einen neuen Entwurf. Optional mit echten Terminvorschlägen. */
  app.post('/api/drafts/generate', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = generateDraftSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const body = parsed.data;

    const visibility = await dealVisibilityFilter(user);
    const deal = await prisma.deal.findFirst({
      where: { AND: [{ id: body.dealId }, visibility] },
      select: { id: true, contact: { select: { email: true, optedOut: true } } },
    });
    if (!deal) return reply.status(404).send({ error: 'not_found' });
    if (!deal.contact) {
      return reply.status(400).send({ error: 'no_contact', message: 'Der Deal hat keinen Kontakt' });
    }
    if (deal.contact.optedOut) {
      return reply
        .status(400)
        .send({ error: 'opted_out', message: 'Dieser Kontakt hat weiterer Kontaktaufnahme widersprochen' });
    }

    let slots;
    if (body.includeMeetingProposals) {
      try {
        slots = await suggestMeetingTimes({
          userId: user.id,
          attendeeEmails: [deal.contact.email],
          durationMinutes: 30,
          maxCandidates: 3,
        });
      } catch (err) {
        // Ohne Terminvorschläge ist der Entwurf immer noch brauchbar.
        logger.warn({ err }, 'Terminvorschläge nicht ermittelbar – Entwurf wird ohne erzeugt');
      }
    }

    try {
      const draft = await generateDraft({
        dealId: body.dealId,
        type: body.type,
        userId: user.id,
        instructions: body.instructions,
        slots,
      });
      return reply.status(201).send({ id: draft.id });
    } catch (err) {
      logger.error({ err, dealId: body.dealId }, 'Entwurf konnte nicht erzeugt werden');
      return reply.status(502).send({ error: 'ai_failed', message: 'Der Entwurf konnte nicht erzeugt werden' });
    }
  });

  /** Bearbeiten. Ein bereits freigegebener Entwurf fällt dadurch zurück auf EDITED. */
  app.patch('/api/drafts/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const parsed = updateDraftSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });

    const draft = await prisma.emailDraft.findFirst({
      where: { id, ...(user.role === 'ADMIN' ? {} : { userId: user.id }) },
      select: { id: true, status: true },
    });
    if (!draft) return reply.status(404).send({ error: 'not_found' });
    if (['SENDING', 'SENT'].includes(draft.status)) {
      return reply.status(409).send({ error: 'already_sent', message: 'Diese Mail wurde bereits versendet' });
    }

    const updated = await prisma.emailDraft.update({
      where: { id },
      data: {
        subject: parsed.data.subject,
        body: parsed.data.body,
        toEmail: parsed.data.toEmail,
        ccEmails: parsed.data.ccEmails,
        // Jede Änderung entzieht eine bereits erteilte Freigabe.
        status: 'EDITED',
        approvedAt: null,
      },
      select: { id: true, status: true, updatedAt: true },
    });

    return { ...updated, updatedAt: updated.updatedAt.toISOString() };
  });

  /**
   * Freigabe und Versand in einem Aufruf – aber mit drei Sperren:
   *
   * 1. Betreff und Empfänger müssen dem entsprechen, was der Benutzer gesehen hat.
   * 2. `updatedAt` muss übereinstimmen: ein zwischenzeitlich geänderter Entwurf
   *    wird abgelehnt, statt die alte Fassung zu senden.
   * 3. Der Statuswechsel auf SENDING wirkt als Sperre gegen Doppelversand.
   *
   * Das ist die Antwort auf die Frage aus Kapitel 16, wie versehentlicher
   * Versand technisch verhindert wird.
   */
  app.post('/api/drafts/:id/approve', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const parsed = approveDraftSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const body = parsed.data;

    const draft = await prisma.emailDraft.findFirst({
      where: { id, ...(user.role === 'ADMIN' ? {} : { userId: user.id }) },
      select: {
        id: true,
        status: true,
        subject: true,
        toEmail: true,
        updatedAt: true,
        deal: { select: { contact: { select: { optedOut: true } } } },
      },
    });
    if (!draft) return reply.status(404).send({ error: 'not_found' });

    if (['SENT', 'SENDING'].includes(draft.status)) {
      return reply.status(409).send({ error: 'already_sent', message: 'Diese Mail wurde bereits versendet' });
    }
    if (draft.deal.contact?.optedOut) {
      return reply.status(400).send({ error: 'opted_out', message: 'Dieser Kontakt darf nicht angeschrieben werden' });
    }

    if (draft.subject !== body.confirmedSubject || draft.toEmail !== body.confirmedToEmail) {
      return reply.status(409).send({
        error: 'content_changed',
        message: 'Betreff oder Empfänger stimmen nicht mit der angezeigten Fassung überein. Bitte neu laden.',
      });
    }
    if (draft.updatedAt.toISOString() !== body.updatedAt) {
      return reply.status(409).send({
        error: 'stale',
        message: 'Der Entwurf wurde zwischenzeitlich geändert. Bitte neu laden und erneut prüfen.',
      });
    }

    await prisma.emailDraft.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedByIp: request.ip },
    });
    await audit({
      userId: user.id,
      action: 'draft.approved',
      entityType: 'EmailDraft',
      entityId: id,
      detail: { subject: draft.subject, to: draft.toEmail },
      ip: request.ip,
    });

    try {
      const result = await sendApprovedDraft(id, request.ip);
      return { status: 'SENT', sentAt: result.sentAt.toISOString() };
    } catch (err) {
      logger.error({ err, draftId: id }, 'Versand nach Freigabe fehlgeschlagen');
      return reply.status(502).send({
        error: 'send_failed',
        message: err instanceof Error ? err.message : 'Der Versand ist fehlgeschlagen',
      });
    }
  });

  app.post('/api/drafts/:id/discard', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };

    const draft = await prisma.emailDraft.findFirst({
      where: { id, ...(user.role === 'ADMIN' ? {} : { userId: user.id }) },
      select: { id: true, status: true },
    });
    if (!draft) return reply.status(404).send({ error: 'not_found' });
    if (['SENT', 'SENDING'].includes(draft.status)) {
      return reply.status(409).send({ error: 'already_sent' });
    }

    await prisma.emailDraft.update({ where: { id }, data: { status: 'DISCARDED' } });
    await audit({ userId: user.id, action: 'draft.discarded', entityType: 'EmailDraft', entityId: id, ip: request.ip });
    return { ok: true };
  });
}
