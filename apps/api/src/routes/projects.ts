import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PROJECT_CONTACT_ROLES,
  PROJECT_CONTACT_ROLE_ORDER,
  PROJECT_MEMBER_ROLES,
  PROJECT_STAGES,
  ACTIVE_PROJECT_STAGES,
} from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { currentUser, requireUser } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { contactDisplayName, upsertContact } from '../domain/upsert.js';
import {
  backfillProjectActivities,
  invalidateProjectCache,
} from '../domain/projectLinking.js';
import { canEditProject, dealSummarySelect, projectVisibilityFilter, toDealSummary } from './helpers.js';

const createProjectSchema = z.object({
  number: z.string().min(1).max(50),
  name: z.string().min(1).max(300),
  description: z.string().max(5000).optional(),
  stage: z.enum(PROJECT_STAGES).default('LEAD'),
  companyId: z.string().optional(),
  leadUserId: z.string().optional(),
  serviceArea: z.string().max(200).optional(),
  siteAddress: z.string().max(300).optional(),
  city: z.string().max(120).optional(),
  postalCode: z.string().max(20).optional(),
  startsOn: z.string().datetime().optional(),
  endsOn: z.string().datetime().optional(),
  aliases: z.array(z.string().min(3).max(120)).max(10).default([]),
});

const updateProjectSchema = createProjectSchema.partial().omit({ number: true });

const addContactSchema = z.object({
  contactId: z.string().optional(),
  /** Alternativ: Kontakt über die Mailadresse anlegen bzw. finden. */
  email: z.string().email().optional(),
  name: z.string().max(200).optional(),
  companyName: z.string().max(200).optional(),
  role: z.enum(PROJECT_CONTACT_ROLES),
  roleDetail: z.string().max(200).optional(),
  isPrimary: z.boolean().default(false),
  note: z.string().max(1000).optional(),
});

const addMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(PROJECT_MEMBER_ROLES).default('ENGINEER'),
  canEdit: z.boolean().default(true),
});

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  /** Projektliste. Zeigt auf einen Blick, wo etwas liegen geblieben ist. */
  app.get('/api/projects', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const query = z
      .object({
        stage: z.enum(PROJECT_STAGES).optional(),
        activeOnly: z.coerce.boolean().default(false),
        search: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);

    const visibility = await projectVisibilityFilter(user);
    const projects = await prisma.project.findMany({
      where: {
        AND: [
          visibility,
          { archivedAt: null },
          query.stage ? { stage: query.stage } : {},
          query.activeOnly ? { stage: { in: [...ACTIVE_PROJECT_STAGES] } } : {},
          query.search
            ? {
                OR: [
                  { number: { contains: query.search, mode: 'insensitive' as const } },
                  { name: { contains: query.search, mode: 'insensitive' as const } },
                  { city: { contains: query.search, mode: 'insensitive' as const } },
                ],
              }
            : {},
        ],
      },
      select: {
        id: true,
        number: true,
        name: true,
        stage: true,
        city: true,
        serviceArea: true,
        lastActivityAt: true,
        startsOn: true,
        leadUser: { select: { id: true, displayName: true } },
        company: { select: { id: true, name: true } },
        _count: { select: { contacts: true, members: true, deals: true, activities: true } },
      },
      orderBy: [{ lastActivityAt: 'desc' }, { number: 'desc' }],
      take: query.limit,
    });

    return {
      projects: projects.map((p) => ({
        id: p.id,
        number: p.number,
        name: p.name,
        stage: p.stage,
        city: p.city,
        serviceArea: p.serviceArea,
        leadUserId: p.leadUser.id,
        leadUserName: p.leadUser.displayName,
        companyId: p.company?.id ?? null,
        companyName: p.company?.name ?? null,
        lastActivityAt: p.lastActivityAt?.toISOString() ?? null,
        startsOn: p.startsOn?.toISOString() ?? null,
        contactCount: p._count.contacts,
        memberCount: p._count.members,
        dealCount: p._count.deals,
        activityCount: p._count.activities,
      })),
    };
  });

  /**
   * Projektdetail: Stammdaten, Beteiligte mit ihren Rollen, das interne Team,
   * die zugehörigen Deals und der gesamte Mailverlauf – die Ansicht, in der ein
   * Bauprojekt tatsächlich bearbeitet wird.
   */
  app.get('/api/projects/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const visibility = await projectVisibilityFilter(user);

    const project = await prisma.project.findFirst({
      where: { AND: [{ id }, visibility] },
      include: {
        leadUser: { select: { id: true, displayName: true, email: true } },
        company: true,
        members: {
          include: { user: { select: { id: true, displayName: true, email: true } } },
        },
        contacts: {
          include: {
            contact: true,
            company: { select: { id: true, name: true } },
          },
        },
        deals: { select: dealSummarySelect, orderBy: { updatedAt: 'desc' }, take: 50 },
        meetings: { orderBy: { startsAt: 'desc' }, take: 20 },
      },
    });
    if (!project) return reply.status(404).send({ error: 'not_found' });

    const activities = await prisma.activity.findMany({
      where: { projectId: id },
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
        attachmentNames: true,
        hasPdfAttachment: true,
        projectLinkMethod: true,
        projectLinkScore: true,
        contact: { select: { id: true, firstName: true, lastName: true, displayName: true, email: true } },
        mailbox: { select: { address: true } },
      },
    });

    return {
      id: project.id,
      number: project.number,
      name: project.name,
      description: project.description,
      stage: project.stage,
      serviceArea: project.serviceArea,
      siteAddress: project.siteAddress,
      city: project.city,
      postalCode: project.postalCode,
      aliases: project.aliases,
      startsOn: project.startsOn?.toISOString() ?? null,
      endsOn: project.endsOn?.toISOString() ?? null,
      lastActivityAt: project.lastActivityAt?.toISOString() ?? null,
      canEdit: await canEditProject(user, id),
      lead: project.leadUser,
      company: project.company
        ? { id: project.company.id, name: project.company.name, website: project.company.website }
        : null,
      members: project.members.map((m) => ({
        id: m.id,
        userId: m.userId,
        name: m.user.displayName,
        email: m.user.email,
        role: m.role,
        canEdit: m.canEdit,
      })),
      // Beteiligte nach Rolle sortiert: Bauherr oben, Sonstige unten.
      contacts: project.contacts
        .map((pc) => ({
          id: pc.id,
          contactId: pc.contactId,
          name: contactDisplayName(pc.contact),
          email: pc.contact.email,
          phone: pc.contact.phone,
          position: pc.contact.position,
          role: pc.role,
          roleDetail: pc.roleDetail,
          isPrimary: pc.isPrimary,
          note: pc.note,
          autoDetected: pc.autoDetected,
          companyId: pc.company?.id ?? null,
          companyName: pc.company?.name ?? null,
          lastContactAt: pc.lastContactAt?.toISOString() ?? null,
        }))
        .sort(
          (a, b) =>
            PROJECT_CONTACT_ROLE_ORDER[a.role] - PROJECT_CONTACT_ROLE_ORDER[b.role] ||
            a.name.localeCompare(b.name, 'de'),
        ),
      deals: project.deals.map(toDealSummary),
      meetings: project.meetings.map((m) => ({
        id: m.id,
        subject: m.subject,
        startsAt: m.startsAt.toISOString(),
        endsAt: m.endsAt.toISOString(),
        status: m.status,
        joinUrl: m.joinUrl,
        attendees: m.attendeeEmails,
        summary: m.summary,
      })),
      activities: activities.map((a) => ({
        id: a.id,
        occurredAt: a.occurredAt.toISOString(),
        direction: a.direction,
        channel: a.channel,
        subject: a.subject,
        summary: a.summary,
        bodyPreview: a.bodyPreview,
        attachmentNames: a.attachmentNames,
        hasPdfAttachment: a.hasPdfAttachment,
        linkMethod: a.projectLinkMethod,
        linkScore: a.projectLinkScore,
        contactId: a.contact?.id ?? null,
        contactName: a.contact ? contactDisplayName(a.contact) : null,
        contactEmail: a.contact?.email ?? null,
        mailbox: a.mailbox?.address ?? null,
      })),
    };
  });

  app.post('/api/projects', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const body = parsed.data;

    const existing = await prisma.project.findUnique({ where: { number: body.number } });
    if (existing) {
      return reply
        .status(409)
        .send({ error: 'number_taken', message: `Projektnummer ${body.number} ist bereits vergeben` });
    }

    const leadUserId = body.leadUserId && user.role === 'ADMIN' ? body.leadUserId : user.id;

    const project = await prisma.project.create({
      data: {
        number: body.number,
        name: body.name,
        description: body.description ?? null,
        stage: body.stage,
        companyId: body.companyId ?? null,
        leadUserId,
        serviceArea: body.serviceArea ?? null,
        siteAddress: body.siteAddress ?? null,
        city: body.city ?? null,
        postalCode: body.postalCode ?? null,
        startsOn: body.startsOn ? new Date(body.startsOn) : null,
        endsOn: body.endsOn ? new Date(body.endsOn) : null,
        aliases: body.aliases,
        // Der Projektleiter ist immer auch Teammitglied.
        members: { create: { userId: leadUserId, role: 'LEAD', canEdit: true } },
      },
      select: { id: true, number: true, name: true },
    });

    invalidateProjectCache();
    await audit({
      userId: user.id,
      action: 'project.created',
      entityType: 'Project',
      entityId: project.id,
      detail: { number: project.number },
      ip: request.ip,
    });

    // Vorhandene Mailhistorie sofort einhängen, damit das Projekt nicht leer startet.
    void backfillProjectActivities(project.id).catch((err) =>
      logger.warn({ err, projectId: project.id }, 'Nachzuordnung nach Projektanlage fehlgeschlagen'),
    );

    return reply.status(201).send(project);
  });

  app.patch('/api/projects/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    if (!(await canEditProject(user, id))) return reply.status(403).send({ error: 'forbidden' });

    const parsed = updateProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const body = parsed.data;

    const project = await prisma.project.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.stage !== undefined ? { stage: body.stage } : {}),
        ...(body.companyId !== undefined ? { companyId: body.companyId } : {}),
        ...(body.serviceArea !== undefined ? { serviceArea: body.serviceArea } : {}),
        ...(body.siteAddress !== undefined ? { siteAddress: body.siteAddress } : {}),
        ...(body.city !== undefined ? { city: body.city } : {}),
        ...(body.postalCode !== undefined ? { postalCode: body.postalCode } : {}),
        ...(body.aliases !== undefined ? { aliases: body.aliases } : {}),
        ...(body.leadUserId && user.role === 'ADMIN' ? { leadUserId: body.leadUserId } : {}),
        ...(body.startsOn !== undefined ? { startsOn: body.startsOn ? new Date(body.startsOn) : null } : {}),
        ...(body.endsOn !== undefined ? { endsOn: body.endsOn ? new Date(body.endsOn) : null } : {}),
      },
      select: { id: true, number: true, name: true, stage: true },
    });

    invalidateProjectCache();
    await audit({ userId: user.id, action: 'project.updated', entityType: 'Project', entityId: id, ip: request.ip });
    return project;
  });

  /* ---------- Beteiligte ---------- */

  app.post('/api/projects/:id/contacts', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    if (!(await canEditProject(user, id))) return reply.status(403).send({ error: 'forbidden' });

    const parsed = addContactSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const body = parsed.data;

    let contactId = body.contactId;
    if (!contactId) {
      if (!body.email) {
        return reply.status(400).send({ error: 'invalid_body', message: 'contactId oder email ist erforderlich' });
      }
      const contact = await upsertContact({
        email: body.email,
        displayName: body.name ?? null,
        companyName: body.companyName ?? null,
        ownerId: user.id,
        source: 'MANUAL',
      });
      if (!contact) {
        return reply.status(400).send({ error: 'invalid_email', message: 'Diese Adresse kann nicht verwendet werden' });
      }
      contactId = contact.id;
    }

    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { companyId: true },
    });

    const participant = await prisma.projectContact.upsert({
      where: { projectId_contactId: { projectId: id, contactId } },
      create: {
        projectId: id,
        contactId,
        companyId: contact?.companyId ?? null,
        role: body.role,
        roleDetail: body.roleDetail ?? null,
        isPrimary: body.isPrimary,
        note: body.note ?? null,
        autoDetected: false,
      },
      update: {
        role: body.role,
        roleDetail: body.roleDetail ?? null,
        isPrimary: body.isPrimary,
        ...(body.note !== undefined ? { note: body.note } : {}),
        // Eine manuell gesetzte Rolle ist keine Vermutung mehr.
        autoDetected: false,
      },
      select: { id: true, contactId: true, role: true },
    });

    invalidateProjectCache();
    await audit({
      userId: user.id,
      action: 'project.contact_added',
      entityType: 'Project',
      entityId: id,
      detail: { contactId, role: body.role },
      ip: request.ip,
    });

    // Ein neuer Beteiligter bringt oft weitere Mails ins Projekt.
    void backfillProjectActivities(id, { limit: 500 }).catch((err) =>
      logger.warn({ err, projectId: id }, 'Nachzuordnung nach Beteiligtenpflege fehlgeschlagen'),
    );

    return reply.status(201).send(participant);
  });

  app.delete('/api/projects/:id/contacts/:contactId', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id, contactId } = request.params as { id: string; contactId: string };
    if (!(await canEditProject(user, id))) return reply.status(403).send({ error: 'forbidden' });

    await prisma.projectContact.deleteMany({ where: { projectId: id, contactId } });
    invalidateProjectCache();
    await audit({
      userId: user.id,
      action: 'project.contact_removed',
      entityType: 'Project',
      entityId: id,
      detail: { contactId },
      ip: request.ip,
    });
    return { ok: true };
  });

  /* ---------- Internes Team ---------- */

  app.post('/api/projects/:id/members', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    if (!(await canEditProject(user, id))) return reply.status(403).send({ error: 'forbidden' });

    const parsed = addMemberSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const body = parsed.data;

    const target = await prisma.user.findUnique({ where: { id: body.userId }, select: { id: true, active: true } });
    if (!target?.active) return reply.status(404).send({ error: 'user_not_found' });

    const member = await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: id, userId: body.userId } },
      create: { projectId: id, userId: body.userId, role: body.role, canEdit: body.canEdit },
      update: { role: body.role, canEdit: body.canEdit },
      select: { id: true, userId: true, role: true, canEdit: true },
    });

    await audit({
      userId: user.id,
      action: 'project.member_added',
      entityType: 'Project',
      entityId: id,
      detail: { memberUserId: body.userId, role: body.role },
      ip: request.ip,
    });
    return reply.status(201).send(member);
  });

  app.delete('/api/projects/:id/members/:userId', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id, userId } = request.params as { id: string; userId: string };
    if (!(await canEditProject(user, id))) return reply.status(403).send({ error: 'forbidden' });

    const project = await prisma.project.findUnique({ where: { id }, select: { leadUserId: true } });
    if (project?.leadUserId === userId) {
      return reply
        .status(400)
        .send({ error: 'lead_required', message: 'Die Projektleitung kann nicht aus dem Team entfernt werden' });
    }

    await prisma.projectMember.deleteMany({ where: { projectId: id, userId } });
    await audit({
      userId: user.id,
      action: 'project.member_removed',
      entityType: 'Project',
      entityId: id,
      detail: { memberUserId: userId },
      ip: request.ip,
    });
    return { ok: true };
  });

  /* ---------- Mailzuordnung ---------- */

  /** Ordnet eine einzelne Mail manuell diesem Projekt zu. */
  app.post('/api/projects/:id/activities/:activityId', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id, activityId } = request.params as { id: string; activityId: string };
    if (!(await canEditProject(user, id))) return reply.status(403).send({ error: 'forbidden' });

    const activity = await prisma.activity.findUnique({
      where: { id: activityId },
      select: { id: true, conversationId: true },
    });
    if (!activity) return reply.status(404).send({ error: 'not_found' });

    const applyToThread = z
      .object({ applyToThread: z.coerce.boolean().default(true) })
      .parse(request.query).applyToThread;

    await prisma.activity.update({
      where: { id: activityId },
      data: { projectId: id, projectLinkMethod: 'MANUAL', projectLinkScore: 100 },
    });

    // Eine manuelle Korrektur gilt sinnvollerweise für den ganzen Verlauf.
    let threadCount = 0;
    if (applyToThread && activity.conversationId) {
      const result = await prisma.activity.updateMany({
        where: { conversationId: activity.conversationId, projectId: null },
        data: { projectId: id, projectLinkMethod: 'CONVERSATION', projectLinkScore: 90 },
      });
      threadCount = result.count;
    }

    await prisma.project.update({ where: { id }, data: { lastActivityAt: new Date() } });
    await prisma.reviewItem.updateMany({
      where: { dedupeKey: { in: [`ambiguous-project:${activityId}`, `unassigned-project:${activityId}`] } },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });

    await audit({
      userId: user.id,
      action: 'project.mail_linked',
      entityType: 'Activity',
      entityId: activityId,
      detail: { projectId: id, threadCount },
      ip: request.ip,
    });

    return { ok: true, threadActivitiesLinked: threadCount };
  });

  /** Löst die Projektzuordnung einer Mail wieder. */
  app.delete('/api/projects/:id/activities/:activityId', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id, activityId } = request.params as { id: string; activityId: string };
    if (!(await canEditProject(user, id))) return reply.status(403).send({ error: 'forbidden' });

    await prisma.activity.updateMany({
      where: { id: activityId, projectId: id },
      data: { projectId: null, projectLinkMethod: null, projectLinkScore: null },
    });
    return { ok: true };
  });

  /** Stößt die Nachzuordnung der Historie erneut an. */
  app.post('/api/projects/:id/rescan', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    if (!(await canEditProject(user, id))) return reply.status(403).send({ error: 'forbidden' });

    const linked = await backfillProjectActivities(id);
    return { linked };
  });
}
