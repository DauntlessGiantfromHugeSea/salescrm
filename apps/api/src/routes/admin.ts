import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { USER_ROLES } from '@salescrm/shared';
import { config } from '../config.js';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { currentUser, requireAdmin, requireUser } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { isAppOnlyEnabled } from '../auth/appToken.js';
import { canReadMailbox, registerMailbox, syncMailboxRegistry } from '../graph/mailboxRegistry.js';
import { enqueueDailyScan, enqueueMailboxSync } from '../jobs/queue.js';

/**
 * Verwaltung: Benutzer, Postfächer, manuelle Läufe.
 * Alles hier ist Administratoren vorbehalten – bis auf die Benutzerliste,
 * die jeder braucht, um jemanden einem Projektteam zuzuordnen.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /** Kolleginnen und Kollegen, die einem Projektteam zugeordnet werden können. */
  app.get('/api/users', { preHandler: requireUser }, async () => {
    const users = await prisma.user.findMany({
      where: { active: true },
      select: { id: true, displayName: true, email: true, role: true },
      orderBy: { displayName: 'asc' },
    });
    return { users };
  });

  app.patch('/api/admin/users/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const admin = currentUser(request);
    const { id } = request.params as { id: string };
    const parsed = z
      .object({ role: z.enum(USER_ROLES).optional(), active: z.boolean().optional() })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });

    // Der letzte Administrator darf sich nicht selbst aussperren.
    if ((parsed.data.role === 'USER' || parsed.data.active === false) && id === admin.id) {
      const otherAdmins = await prisma.user.count({
        where: { role: 'ADMIN', active: true, id: { not: id } },
      });
      if (otherAdmins === 0) {
        return reply.status(400).send({
          error: 'last_admin',
          message: 'Es muss mindestens ein aktiver Administrator bleiben',
        });
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: parsed.data,
      select: { id: true, displayName: true, role: true, active: true },
    });
    await audit({
      userId: admin.id,
      action: 'user.updated',
      entityType: 'User',
      entityId: id,
      detail: parsed.data,
      ip: request.ip,
    });
    return user;
  });

  /* ---------- Postfächer ---------- */

  app.get('/api/admin/mailboxes', { preHandler: requireAdmin }, async () => {
    const mailboxes = await prisma.mailbox.findMany({
      include: {
        ownerUser: { select: { id: true, displayName: true } },
        syncStates: { select: { resource: true, lastRunAt: true, lastError: true, itemsSynced: true } },
        _count: { select: { activities: true } },
      },
      orderBy: [{ syncEnabled: 'desc' }, { address: 'asc' }],
    });

    return {
      appOnlyEnabled: isAppOnlyEnabled(),
      accessPolicyGroup: config.MS_MAILBOX_GROUP || null,
      mailboxes: mailboxes.map((m) => ({
        id: m.id,
        address: m.address,
        displayName: m.displayName,
        kind: m.kind,
        authMode: m.authMode,
        syncEnabled: m.syncEnabled,
        initialImportDone: m.initialImportDone,
        folders: m.folders.length > 0 ? m.folders : config.importMailFolders,
        ownerUserId: m.ownerUserId,
        ownerName: m.ownerUser?.displayName ?? null,
        lastSyncAt: m.lastSyncAt?.toISOString() ?? null,
        lastError: m.lastError,
        messagesSynced: m.messagesSynced,
        activityCount: m._count.activities,
        syncStates: m.syncStates.map((s) => ({ ...s, lastRunAt: s.lastRunAt?.toISOString() ?? null })),
      })),
    };
  });

  /**
   * Sucht im Tenant nach Postfächern, die die App lesen darf.
   * Gefundene Postfächer werden deaktiviert angelegt – erst wenn ein
   * Administrator einen Zuständigen einträgt, beginnt der Abgleich.
   */
  app.post('/api/admin/mailboxes/discover', { preHandler: requireAdmin }, async (request, reply) => {
    if (!isAppOnlyEnabled()) {
      return reply.status(400).send({
        error: 'app_only_disabled',
        message:
          'Der firmenweite Zugriff ist nicht aktiviert. MS_APP_ONLY_ENABLED=true setzen und die ' +
          'Anwendungsberechtigungen im Tenant freigeben (siehe docs/AZURE_SETUP.md).',
      });
    }
    try {
      const result = await syncMailboxRegistry();
      return result;
    } catch (err) {
      logger.error({ err }, 'Postfachsuche fehlgeschlagen');
      return reply.status(502).send({
        error: 'graph_failed',
        message: 'Die Postfächer konnten nicht gelesen werden. Admin-Zustimmung erteilt?',
      });
    }
  });

  app.post('/api/admin/mailboxes', { preHandler: requireAdmin }, async (request, reply) => {
    const admin = currentUser(request);
    const parsed = z
      .object({
        address: z.string().email(),
        displayName: z.string().min(1).max(200),
        kind: z.enum(['USER', 'SHARED']).default('SHARED'),
        ownerUserId: z.string().nullable().optional(),
        folders: z.array(z.string().min(1).max(60)).max(20).optional(),
        syncEnabled: z.boolean().default(false),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const body = parsed.data;

    if (!isAppOnlyEnabled()) {
      return reply.status(400).send({
        error: 'app_only_disabled',
        message: 'Gemeinsame Postfächer brauchen den firmenweiten Zugriff (MS_APP_ONLY_ENABLED).',
      });
    }

    // Vor dem Aktivieren prüfen, ob der Zugriff tatsächlich funktioniert –
    // sonst scheitert erst der nächtliche Lauf, und niemand merkt es.
    const readable = await canReadMailbox(body.address).catch(() => false);
    if (!readable) {
      return reply.status(400).send({
        error: 'not_accessible',
        message:
          `Das Postfach ${body.address} ist für die Anwendung nicht lesbar. ` +
          'Steht es in der Sicherheitsgruppe der ApplicationAccessPolicy?',
      });
    }

    const mailbox = await registerMailbox({
      address: body.address,
      displayName: body.displayName,
      kind: body.kind,
      authMode: 'APP_ONLY',
      ownerUserId: body.ownerUserId ?? null,
      folders: body.folders,
      syncEnabled: body.syncEnabled,
    });

    await audit({
      userId: admin.id,
      action: 'mailbox.registered',
      entityType: 'Mailbox',
      entityId: mailbox.id,
      detail: { address: body.address, kind: body.kind },
      ip: request.ip,
    });
    return reply.status(201).send({ id: mailbox.id, address: mailbox.address });
  });

  app.patch('/api/admin/mailboxes/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const admin = currentUser(request);
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        displayName: z.string().min(1).max(200).optional(),
        ownerUserId: z.string().nullable().optional(),
        folders: z.array(z.string().min(1).max(60)).max(20).optional(),
        syncEnabled: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });

    const existing = await prisma.mailbox.findUnique({ where: { id }, select: { ownerUserId: true } });
    if (!existing) return reply.status(404).send({ error: 'not_found' });

    // Ohne Zuständigen kann der Import die entstehenden Deals niemandem zuordnen.
    const nextOwner = parsed.data.ownerUserId !== undefined ? parsed.data.ownerUserId : existing.ownerUserId;
    if (parsed.data.syncEnabled === true && !nextOwner) {
      return reply.status(400).send({
        error: 'owner_required',
        message: 'Vor dem Aktivieren muss ein zuständiger Kollege eingetragen werden',
      });
    }

    const mailbox = await prisma.mailbox.update({
      where: { id },
      data: parsed.data,
      select: { id: true, address: true, syncEnabled: true, ownerUserId: true },
    });

    await audit({
      userId: admin.id,
      action: 'mailbox.updated',
      entityType: 'Mailbox',
      entityId: id,
      detail: parsed.data,
      ip: request.ip,
    });
    return mailbox;
  });

  /* ---------- Manuelle Läufe ---------- */

  app.post('/api/admin/sync/mailbox/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const mailbox = await prisma.mailbox.findUnique({ where: { id }, select: { id: true, address: true } });
    if (!mailbox) return reply.status(404).send({ error: 'not_found' });

    await enqueueMailboxSync(mailbox.id);
    return { queued: true, mailbox: mailbox.address };
  });

  app.post('/api/admin/scan', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    await enqueueDailyScan(user.id);
    return { queued: true };
  });

  /** Protokoll der Aktionen mit Außenwirkung. */
  app.get('/api/admin/audit', { preHandler: requireAdmin }, async (request) => {
    const query = z
      .object({
        action: z.string().optional(),
        entityId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);

    const entries = await prisma.auditLog.findMany({
      where: {
        ...(query.action ? { action: query.action } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: { user: { select: { displayName: true } } },
    });

    return {
      entries: entries.map((e) => ({
        id: e.id,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        detail: e.detail,
        ip: e.ip,
        userName: e.user?.displayName ?? 'System',
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });
}
