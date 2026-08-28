import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { currentUser, requireUser } from '../auth/session.js';
import {
  bucketOf,
  dealSummarySelect,
  dealVisibilityFilter,
  toDealSummary,
  type DealBucket,
  type DealSummaryDto,
} from './helpers.js';

/**
 * Die Tagesübersicht aus Kapitel 9.1: was heute zu tun ist, in vier Blöcken.
 * Alles andere im Dashboard ist Detailansicht dieser Liste.
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/dashboard', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const visibility = await dealVisibilityFilter(user);
    const now = new Date();

    const openDeals = await prisma.deal.findMany({
      where: { AND: [visibility, { isOpen: true, stage: { notIn: ['WON', 'LOST'] } }] },
      select: dealSummarySelect,
      orderBy: [{ relevance: 'asc' }, { lastContactAt: 'asc' }],
      take: 200,
    });

    const buckets: Record<DealBucket, DealSummaryDto[]> = {
      A_FOLLOW_UP: [],
      B_REACTIVATION: [],
      C_COLD_OUTREACH: [],
    };

    for (const deal of openDeals) {
      buckets[bucketOf(deal, now)].push(toDealSummary(deal));
    }

    const conflicts = await prisma.reviewItem.findMany({
      where: {
        status: 'OPEN',
        ...(user.role === 'ADMIN' ? {} : { OR: [{ userId: user.id }, { userId: null }] }),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        type: true,
        status: true,
        title: true,
        detail: true,
        dealId: true,
        projectId: true,
        contactId: true,
        companyId: true,
        relatedContactId: true,
        relatedCompanyId: true,
        createdAt: true,
      },
    });

    const draftsPending = await prisma.emailDraft.count({
      where: {
        status: { in: ['DRAFT', 'EDITED', 'APPROVED'] },
        ...(user.role === 'ADMIN' ? {} : { userId: user.id }),
      },
    });

    return {
      date: now.toISOString().slice(0, 10),
      generatedAt: now.toISOString(),
      buckets,
      conflicts: conflicts.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
      counts: {
        followUp: buckets.A_FOLLOW_UP.length,
        reactivation: buckets.B_REACTIVATION.length,
        coldOutreach: buckets.C_COLD_OUTREACH.length,
        conflicts: conflicts.length,
        draftsPending,
      },
    };
  });

  /** Kennzahlen der letzten Läufe – zeigt, ob die Automatik überhaupt läuft. */
  app.get('/api/dashboard/status', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);

    const [lastRun, syncStates, mailboxes] = await Promise.all([
      prisma.dailyRun.findFirst({ where: { userId: user.id }, orderBy: { runDate: 'desc' } }),
      prisma.syncState.findMany({
        where: { userId: user.id },
        select: { resource: true, lastRunAt: true, lastError: true, itemsSynced: true },
      }),
      user.role === 'ADMIN'
        ? prisma.mailbox.findMany({
            select: {
              address: true,
              displayName: true,
              syncEnabled: true,
              lastSyncAt: true,
              lastError: true,
              messagesSynced: true,
              initialImportDone: true,
              ownerUser: { select: { displayName: true } },
            },
            orderBy: { address: 'asc' },
          })
        : prisma.mailbox.findMany({
            where: { ownerUserId: user.id },
            select: {
              address: true,
              displayName: true,
              syncEnabled: true,
              lastSyncAt: true,
              lastError: true,
              messagesSynced: true,
              initialImportDone: true,
              ownerUser: { select: { displayName: true } },
            },
          }),
    ]);

    return {
      lastRun: lastRun
        ? {
            date: lastRun.runDate.toISOString().slice(0, 10),
            dealsEvaluated: lastRun.dealsEvaluated,
            followUp: lastRun.followUpCount,
            reactivation: lastRun.reactivationCount,
            coldOutreach: lastRun.coldOutreachCount,
            conflicts: lastRun.conflictCount,
            finishedAt: lastRun.finishedAt?.toISOString() ?? null,
            error: lastRun.error,
          }
        : null,
      syncStates: syncStates.map((s) => ({
        ...s,
        lastRunAt: s.lastRunAt?.toISOString() ?? null,
      })),
      mailboxes: mailboxes.map((m) => ({
        ...m,
        lastSyncAt: m.lastSyncAt?.toISOString() ?? null,
        ownerName: m.ownerUser?.displayName ?? null,
      })),
    };
  });
}
