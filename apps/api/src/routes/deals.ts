import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEAL_STAGES, updateDealSchema } from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { currentUser, requireUser } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { contactDisplayName } from '../domain/upsert.js';
import { dealSummarySelect, dealVisibilityFilter, toDealSummary } from './helpers.js';

const listQuerySchema = z.object({
  stage: z.enum(DEAL_STAGES).optional(),
  projectId: z.string().optional(),
  contactId: z.string().optional(),
  companyId: z.string().optional(),
  ownerId: z.string().optional(),
  openOnly: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createDealSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5000).optional(),
  contactId: z.string().optional(),
  companyId: z.string().optional(),
  projectId: z.string().optional(),
  serviceArea: z.string().max(200).optional(),
  ownerId: z.string().optional(),
  nextAction: z.string().max(500).optional(),
  dueDate: z.string().datetime().optional(),
});

export async function dealRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/deals', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    const query = parsed.data;

    const visibility = await dealVisibilityFilter(user);
    const where = {
      AND: [
        visibility,
        query.stage ? { stage: query.stage } : {},
        query.projectId ? { projectId: query.projectId } : {},
        query.contactId ? { contactId: query.contactId } : {},
        query.companyId ? { companyId: query.companyId } : {},
        query.ownerId ? { ownerId: query.ownerId } : {},
        query.openOnly ? { isOpen: true, stage: { notIn: ['WON' as const, 'LOST' as const] } } : {},
        query.search
          ? {
              OR: [
                { title: { contains: query.search, mode: 'insensitive' as const } },
                { company: { name: { contains: query.search, mode: 'insensitive' as const } } },
                { contact: { email: { contains: query.search, mode: 'insensitive' as const } } },
              ],
            }
          : {},
      ],
    };

    const [deals, total] = await Promise.all([
      prisma.deal.findMany({
        where,
        select: dealSummarySelect,
        orderBy: { updatedAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      prisma.deal.count({ where }),
    ]);

    return { deals: deals.map(toDealSummary), total, limit: query.limit, offset: query.offset };
  });

  app.get('/api/deals/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const visibility = await dealVisibilityFilter(user);

    const deal = await prisma.deal.findFirst({
      where: { AND: [{ id }, visibility] },
      include: {
        owner: { select: { id: true, displayName: true } },
        company: true,
        contact: true,
        project: { select: { id: true, number: true, name: true, stage: true } },
        activities: {
          orderBy: { occurredAt: 'desc' },
          take: 50,
          select: {
            id: true,
            occurredAt: true,
            direction: true,
            channel: true,
            subject: true,
            summary: true,
            bodyPreview: true,
            replyPending: true,
            hasPdfAttachment: true,
            attachmentNames: true,
          },
        },
        drafts: { orderBy: { createdAt: 'desc' }, take: 10 },
        meetings: { orderBy: { startsAt: 'desc' }, take: 10 },
      },
    });

    if (!deal) return reply.status(404).send({ error: 'not_found' });

    return {
      id: deal.id,
      title: deal.title,
      description: deal.description,
      stage: deal.stage,
      serviceArea: deal.serviceArea,
      relevance: deal.relevance,
      source: deal.source,
      nextAction: deal.nextAction,
      dueDate: deal.dueDate?.toISOString() ?? null,
      followUpDate: deal.followUpDate?.toISOString() ?? null,
      lastContactAt: deal.lastContactAt?.toISOString() ?? null,
      openReasons: deal.openReasons,
      isOpen: deal.isOpen,
      ownerId: deal.ownerId,
      ownerName: deal.owner.displayName,
      companyId: deal.companyId,
      companyName: deal.company?.name ?? null,
      contactId: deal.contactId,
      contactName: deal.contact ? contactDisplayName(deal.contact) : null,
      contactEmail: deal.contact?.email ?? null,
      hasDraft: deal.drafts.some((d) => ['DRAFT', 'EDITED', 'APPROVED'].includes(d.status)),
      project: deal.project,
      company: deal.company
        ? {
            id: deal.company.id,
            name: deal.company.name,
            website: deal.company.website,
            industry: deal.company.industry,
            size: deal.company.size,
            profile: deal.company.profile,
            trustLevel: deal.company.trustLevel,
          }
        : null,
      contact: deal.contact
        ? {
            id: deal.contact.id,
            firstName: deal.contact.firstName,
            lastName: deal.contact.lastName,
            email: deal.contact.email,
            phone: deal.contact.phone,
            position: deal.contact.position,
            decisionMakerLevel: deal.contact.decisionMakerLevel,
          }
        : null,
      activities: deal.activities.map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() })),
      drafts: deal.drafts.map((d) => ({
        id: d.id,
        dealId: d.dealId,
        type: d.type,
        status: d.status,
        subject: d.subject,
        body: d.body,
        toEmail: d.toEmail,
        toName: d.toName,
        ccEmails: d.ccEmails,
        model: d.model,
        rationale: d.rationale,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
        sentAt: d.sentAt?.toISOString() ?? null,
        error: d.error,
      })),
      meetings: deal.meetings.map((m) => ({
        id: m.id,
        dealId: m.dealId,
        subject: m.subject,
        startsAt: m.startsAt.toISOString(),
        endsAt: m.endsAt.toISOString(),
        status: m.status,
        joinUrl: m.joinUrl,
        attendees: m.attendeeEmails,
        summary: m.summary,
        transcriptFetchedAt: m.transcriptFetchedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post('/api/deals', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = createDealSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const body = parsed.data;

    // Nur Administratoren dürfen einen Deal einem anderen Kollegen zuweisen.
    const ownerId = body.ownerId && user.role === 'ADMIN' ? body.ownerId : user.id;

    const deal = await prisma.deal.create({
      data: {
        title: body.title,
        description: body.description ?? null,
        contactId: body.contactId ?? null,
        companyId: body.companyId ?? null,
        projectId: body.projectId ?? null,
        serviceArea: body.serviceArea ?? null,
        nextAction: body.nextAction ?? null,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        ownerId,
        source: 'MANUAL',
        stage: 'NEW',
      },
      select: dealSummarySelect,
    });

    await audit({
      userId: user.id,
      action: 'deal.created',
      entityType: 'Deal',
      entityId: deal.id,
      ip: request.ip,
    });
    return reply.status(201).send(toDealSummary(deal));
  });

  app.patch('/api/deals/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const parsed = updateDealSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const body = parsed.data;

    const visibility = await dealVisibilityFilter(user);
    const existing = await prisma.deal.findFirst({
      where: { AND: [{ id }, visibility] },
      select: { id: true, stage: true, ownerId: true },
    });
    if (!existing) return reply.status(404).send({ error: 'not_found' });

    if (body.ownerId && body.ownerId !== existing.ownerId && user.role !== 'ADMIN') {
      return reply.status(403).send({ error: 'forbidden', message: 'Nur Administratoren dürfen den Owner ändern' });
    }

    const deal = await prisma.deal.update({
      where: { id },
      data: {
        ...(body.stage !== undefined ? { stage: body.stage } : {}),
        ...(body.nextAction !== undefined ? { nextAction: body.nextAction } : {}),
        ...(body.dueDate !== undefined ? { dueDate: body.dueDate ? new Date(body.dueDate) : null } : {}),
        ...(body.followUpDate !== undefined
          ? { followUpDate: body.followUpDate ? new Date(body.followUpDate) : null }
          : {}),
        ...(body.relevance !== undefined ? { relevance: body.relevance } : {}),
        ...(body.serviceArea !== undefined ? { serviceArea: body.serviceArea } : {}),
        ...(body.ownerId ? { ownerId: body.ownerId } : {}),
        ...(body.stage && ['WON', 'LOST'].includes(body.stage) ? { closedAt: new Date(), isOpen: false } : {}),
      },
      select: dealSummarySelect,
    });

    if (body.stage && body.stage !== existing.stage) {
      await audit({
        userId: user.id,
        action: 'deal.stage_changed',
        entityType: 'Deal',
        entityId: id,
        detail: { from: existing.stage, to: body.stage },
        ip: request.ip,
      });
    }

    return toDealSummary(deal);
  });
}
