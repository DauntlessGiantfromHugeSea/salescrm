import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DECISION_MAKER_LEVELS, PROJECT_CONTACT_ROLE_LABELS } from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { currentUser, requireUser } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { contactDisplayName } from '../domain/upsert.js';

/**
 * Kontakte und Firmen.
 *
 * Die Detailansicht beantwortet die Frage „wie stehen wir zu dieser Person" –
 * über alle Projekte hinweg, mit dem gesamten Schriftwechsel aus allen
 * Firmenpostfächern, nicht nur dem eigenen.
 */
export async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/contacts', { preHandler: requireUser }, async (request) => {
    const query = z
      .object({
        search: z.string().max(200).optional(),
        companyId: z.string().optional(),
        projectId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const where = {
      mergedIntoId: null,
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.projectId ? { projectRoles: { some: { projectId: query.projectId } } } : {}),
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search, mode: 'insensitive' as const } },
              { firstName: { contains: query.search, mode: 'insensitive' as const } },
              { lastName: { contains: query.search, mode: 'insensitive' as const } },
              { displayName: { contains: query.search, mode: 'insensitive' as const } },
              { company: { name: { contains: query.search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          displayName: true,
          phone: true,
          position: true,
          decisionMakerLevel: true,
          trustLevel: true,
          emailCount: true,
          lastInboundAt: true,
          lastOutboundAt: true,
          optedOut: true,
          company: { select: { id: true, name: true } },
          _count: { select: { deals: true, projectRoles: true } },
        },
        orderBy: [{ lastInboundAt: 'desc' }, { emailCount: 'desc' }],
        take: query.limit,
        skip: query.offset,
      }),
      prisma.contact.count({ where }),
    ]);

    return {
      total,
      contacts: contacts.map((c) => ({
        id: c.id,
        name: contactDisplayName(c),
        email: c.email,
        phone: c.phone,
        position: c.position,
        decisionMakerLevel: c.decisionMakerLevel,
        trustLevel: c.trustLevel,
        emailCount: c.emailCount,
        optedOut: c.optedOut,
        lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
        lastOutboundAt: c.lastOutboundAt?.toISOString() ?? null,
        companyId: c.company?.id ?? null,
        companyName: c.company?.name ?? null,
        dealCount: c._count.deals,
        projectCount: c._count.projectRoles,
      })),
    };
  });

  app.get('/api/contacts/:id', { preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const contact = await prisma.contact.findUnique({
      where: { id },
      include: {
        company: true,
        projectRoles: {
          include: {
            project: { select: { id: true, number: true, name: true, stage: true } },
            company: { select: { id: true, name: true } },
          },
        },
        deals: {
          select: {
            id: true,
            title: true,
            stage: true,
            nextAction: true,
            lastContactAt: true,
            owner: { select: { displayName: true } },
            project: { select: { id: true, number: true, name: true } },
          },
          orderBy: { updatedAt: 'desc' },
          take: 20,
        },
      },
    });
    if (!contact) return reply.status(404).send({ error: 'not_found' });

    const activities = await prisma.activity.findMany({
      where: { contactId: id },
      orderBy: { occurredAt: 'desc' },
      take: 100,
      select: {
        id: true,
        occurredAt: true,
        direction: true,
        channel: true,
        subject: true,
        summary: true,
        bodyPreview: true,
        replyPending: true,
        attachmentNames: true,
        hasPdfAttachment: true,
        mailbox: { select: { address: true } },
        project: { select: { id: true, number: true, name: true } },
        deal: { select: { id: true, title: true } },
      },
    });

    return {
      id: contact.id,
      name: contactDisplayName(contact),
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      position: contact.position,
      decisionMakerLevel: contact.decisionMakerLevel,
      trustLevel: contact.trustLevel,
      source: contact.source,
      emailCount: contact.emailCount,
      optedOut: contact.optedOut,
      lastInboundAt: contact.lastInboundAt?.toISOString() ?? null,
      lastOutboundAt: contact.lastOutboundAt?.toISOString() ?? null,
      company: contact.company
        ? {
            id: contact.company.id,
            name: contact.company.name,
            website: contact.company.website,
            industry: contact.company.industry,
            profile: contact.company.profile,
          }
        : null,
      // In welchem Projekt hat diese Person welche Rolle?
      projects: contact.projectRoles.map((pr) => ({
        projectId: pr.project.id,
        number: pr.project.number,
        name: pr.project.name,
        stage: pr.project.stage,
        role: pr.role,
        roleLabel: PROJECT_CONTACT_ROLE_LABELS[pr.role],
        roleDetail: pr.roleDetail,
        isPrimary: pr.isPrimary,
        autoDetected: pr.autoDetected,
        actingFor: pr.company?.name ?? null,
        lastContactAt: pr.lastContactAt?.toISOString() ?? null,
      })),
      deals: contact.deals.map((d) => ({
        id: d.id,
        title: d.title,
        stage: d.stage,
        nextAction: d.nextAction,
        ownerName: d.owner.displayName,
        lastContactAt: d.lastContactAt?.toISOString() ?? null,
        projectId: d.project?.id ?? null,
        projectNumber: d.project?.number ?? null,
      })),
      activities: activities.map((a) => ({
        id: a.id,
        occurredAt: a.occurredAt.toISOString(),
        direction: a.direction,
        channel: a.channel,
        subject: a.subject,
        summary: a.summary,
        bodyPreview: a.bodyPreview,
        replyPending: a.replyPending,
        attachmentNames: a.attachmentNames,
        hasPdfAttachment: a.hasPdfAttachment,
        mailbox: a.mailbox?.address ?? null,
        projectId: a.project?.id ?? null,
        projectNumber: a.project?.number ?? null,
        projectName: a.project?.name ?? null,
        dealId: a.deal?.id ?? null,
        dealTitle: a.deal?.title ?? null,
      })),
    };
  });

  app.patch('/api/contacts/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        firstName: z.string().max(120).nullable().optional(),
        lastName: z.string().max(120).nullable().optional(),
        phone: z.string().max(50).nullable().optional(),
        position: z.string().max(200).nullable().optional(),
        decisionMakerLevel: z.enum(DECISION_MAKER_LEVELS).optional(),
        companyId: z.string().nullable().optional(),
        /** Widerspruch gegen weitere Kontaktaufnahme. Sperrt jeden Versand. */
        optedOut: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });

    const contact = await prisma.contact.update({
      where: { id },
      data: {
        ...parsed.data,
        // Von Hand gepflegte Daten sind verlässlich.
        trustLevel: 'HIGH',
      },
      select: { id: true, optedOut: true },
    });

    if (parsed.data.optedOut === true) {
      // Offene Entwürfe an diesen Kontakt dürfen nicht mehr rausgehen.
      await prisma.emailDraft.updateMany({
        where: { deal: { contactId: id }, status: { in: ['DRAFT', 'EDITED', 'APPROVED'] } },
        data: { status: 'DISCARDED' },
      });
      await audit({
        userId: user.id,
        action: 'contact.opted_out',
        entityType: 'Contact',
        entityId: id,
        ip: request.ip,
      });
    }

    return contact;
  });

  app.get('/api/companies', { preHandler: requireUser }, async (request) => {
    const query = z
      .object({ search: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);

    const companies = await prisma.company.findMany({
      where: {
        mergedIntoId: null,
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' as const } },
                { emailDomain: { contains: query.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        website: true,
        emailDomain: true,
        industry: true,
        trustLevel: true,
        _count: { select: { contacts: true, deals: true, projects: true } },
      },
      orderBy: { name: 'asc' },
      take: query.limit,
    });

    return {
      companies: companies.map((c) => ({
        id: c.id,
        name: c.name,
        website: c.website,
        emailDomain: c.emailDomain,
        industry: c.industry,
        trustLevel: c.trustLevel,
        contactCount: c._count.contacts,
        dealCount: c._count.deals,
        projectCount: c._count.projects,
      })),
    };
  });
}
