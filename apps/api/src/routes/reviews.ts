import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveReviewSchema } from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { currentUser, requireUser } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { mergeCompanies, mergeContacts } from '../domain/duplicates.js';

/**
 * Bucket D: die Prüfliste.
 *
 * Hier wird entschieden, was das System nicht selbst entscheiden darf –
 * Dubletten, unklare Zuordnungen, Widersprüche zwischen Planner und CRM.
 */
export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/reviews', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const query = z
      .object({
        status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']).default('OPEN'),
        type: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);

    const items = await prisma.reviewItem.findMany({
      where: {
        status: query.status,
        ...(query.type ? { type: query.type as never } : {}),
        ...(user.role === 'ADMIN' ? {} : { OR: [{ userId: user.id }, { userId: null }] }),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: {
        deal: { select: { id: true, title: true } },
        project: { select: { id: true, number: true, name: true } },
      },
    });

    // Zu Dubletten die beiden betroffenen Datensätze mitliefern, damit im
    // Dashboard direkt vergleichbar ist, was zusammengeführt werden soll.
    const contactIds = items.flatMap((i) => [i.contactId, i.relatedContactId]).filter((id): id is string => Boolean(id));
    const companyIds = items.flatMap((i) => [i.companyId, i.relatedCompanyId]).filter((id): id is string => Boolean(id));

    const [contacts, companies] = await Promise.all([
      contactIds.length
        ? prisma.contact.findMany({
            where: { id: { in: contactIds } },
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              phone: true,
              position: true,
              emailCount: true,
              createdAt: true,
              company: { select: { name: true } },
            },
          })
        : [],
      companyIds.length
        ? prisma.company.findMany({
            where: { id: { in: companyIds } },
            select: {
              id: true,
              name: true,
              emailDomain: true,
              website: true,
              createdAt: true,
              _count: { select: { contacts: true, deals: true } },
            },
          })
        : [],
    ]);

    const contactMap = new Map(contacts.map((c) => [c.id, c]));
    const companyMap = new Map(companies.map((c) => [c.id, c]));

    return {
      items: items.map((i) => ({
        id: i.id,
        type: i.type,
        status: i.status,
        title: i.title,
        detail: i.detail,
        createdAt: i.createdAt.toISOString(),
        dealId: i.dealId,
        dealTitle: i.deal?.title ?? null,
        projectId: i.projectId,
        projectNumber: i.project?.number ?? null,
        projectName: i.project?.name ?? null,
        candidates: {
          contactA: i.contactId ? contactMap.get(i.contactId) ?? null : null,
          contactB: i.relatedContactId ? contactMap.get(i.relatedContactId) ?? null : null,
          companyA: i.companyId ? companyMap.get(i.companyId) ?? null : null,
          companyB: i.relatedCompanyId ? companyMap.get(i.relatedCompanyId) ?? null : null,
        },
      })),
    };
  });

  /**
   * Erledigt eine Prüfaufgabe.
   *
   * MERGE führt zwei Datensätze zusammen, KEEP_BOTH hält fest, dass es zwei
   * verschiedene sind (und die Prüfung nie wiederkehrt), DISMISS legt sie
   * beiseite, RESOLVE hakt sie ab.
   */
  app.post('/api/reviews/:id/resolve', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const parsed = resolveReviewSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const body = parsed.data;

    const item = await prisma.reviewItem.findFirst({
      where: { id, ...(user.role === 'ADMIN' ? {} : { OR: [{ userId: user.id }, { userId: null }] }) },
    });
    if (!item) return reply.status(404).send({ error: 'not_found' });
    if (item.status !== 'OPEN') return reply.status(409).send({ error: 'already_resolved' });

    if (body.action === 'MERGE') {
      const isContact = item.type === 'DUPLICATE_CONTACT';
      const idA = isContact ? item.contactId : item.companyId;
      const idB = isContact ? item.relatedContactId : item.relatedCompanyId;
      if (!idA || !idB) {
        return reply.status(400).send({ error: 'nothing_to_merge', message: 'Der Eintrag enthält kein Paar' });
      }

      const keepId = body.keepId ?? idA;
      const mergeId = keepId === idA ? idB : idA;

      try {
        if (isContact) await mergeContacts(keepId, mergeId);
        else await mergeCompanies(keepId, mergeId);
      } catch (err) {
        logger.error({ err, reviewId: id }, 'Zusammenführung fehlgeschlagen');
        return reply.status(500).send({ error: 'merge_failed', message: 'Die Zusammenführung ist fehlgeschlagen' });
      }

      await audit({
        userId: user.id,
        action: isContact ? 'contact.merged' : 'company.merged',
        entityType: isContact ? 'Contact' : 'Company',
        entityId: keepId,
        detail: { mergedId: mergeId, reviewId: id },
        ip: request.ip,
      });
    }

    await prisma.reviewItem.update({
      where: { id },
      data: {
        // KEEP_BOTH und DISMISS werden beide als DISMISSED abgelegt: die
        // Erkennung legt einen einmal verworfenen Fall nicht erneut an.
        status: body.action === 'DISMISS' || body.action === 'KEEP_BOTH' ? 'DISMISSED' : 'RESOLVED',
        resolutionNote: body.note ?? null,
        resolvedAt: new Date(),
      },
    });

    return { ok: true };
  });
}
