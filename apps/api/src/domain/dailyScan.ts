import { classifyBucket, evaluateDeal, type DealRuleInput } from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { detectPlannerConflicts } from '../graph/plannerSync.js';
import { detectDuplicates } from './duplicates.js';

/**
 * Der tägliche Priorisierungslauf (Kapitel 9).
 *
 * Bewertet alle Deals eines Benutzers neu, schreibt das Ergebnis in den Cache
 * am Deal und erzeugt die Prüfaufgaben für Bucket D. Der Lauf ist idempotent:
 * mehrfaches Ausführen am selben Tag ändert nichts am Ergebnis.
 */
export interface DailyScanResult {
  dealsEvaluated: number;
  followUpCount: number;
  reactivationCount: number;
  coldOutreachCount: number;
  conflictCount: number;
  stageChanges: number;
}

export async function runDailyScan(userId: string): Promise<DailyScanResult> {
  const now = new Date();
  const result: DailyScanResult = {
    dealsEvaluated: 0,
    followUpCount: 0,
    reactivationCount: 0,
    coldOutreachCount: 0,
    conflictCount: 0,
    stageChanges: 0,
  };

  const deals = await prisma.deal.findMany({
    where: { ownerId: userId, stage: { notIn: ['WON', 'LOST'] } },
    select: {
      id: true,
      stage: true,
      nextAction: true,
      dueDate: true,
      followUpDate: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      meetings: {
        where: { status: 'SCHEDULED', startsAt: { gte: now } },
        select: { id: true },
        take: 1,
      },
      plannerTasks: {
        where: { completedAt: null, dueAt: { lt: now } },
        select: { id: true },
        take: 1,
      },
    },
  });

  for (const deal of deals) {
    result.dealsEvaluated++;

    const input: DealRuleInput = {
      stage: deal.stage,
      nextAction: deal.nextAction,
      dueDate: deal.dueDate,
      followUpDate: deal.followUpDate,
      lastOutboundAt: deal.lastOutboundAt,
      lastInboundAt: deal.lastInboundAt,
      hasConfirmedMeeting: deal.meetings.length > 0,
      hasOverduePlannerTask: deal.plannerTasks.length > 0,
    };

    const evaluation = evaluateDeal(input, config.ruleConfig, now);

    // Die KI darf Stufen vorschlagen, aber nicht setzen (Kapitel 7).
    // Einzige Ausnahme ist die klar definierte Regel "Follow-up fällig".
    const shouldSetFollowUpDue =
      evaluation.suggestedStage === 'FOLLOW_UP_DUE' &&
      ['NEW', 'OPEN', 'AWAITING_REPLY'].includes(deal.stage);

    if (shouldSetFollowUpDue) result.stageChanges++;

    await prisma.deal.update({
      where: { id: deal.id },
      data: {
        isOpen: evaluation.isOpen,
        openReasons: evaluation.reasons,
        lastEvaluatedAt: now,
        ...(shouldSetFollowUpDue ? { stage: 'FOLLOW_UP_DUE' as const } : {}),
      },
    });

    if (!evaluation.isOpen) continue;

    const bucket = classifyBucket(input, config.ruleConfig, now);
    if (bucket === 'A_FOLLOW_UP') result.followUpCount++;
    else if (bucket === 'B_REACTIVATION') result.reactivationCount++;
    else result.coldOutreachCount++;
  }

  // Bucket D füllen: Planner-Konflikte, Dubletten, unklare Zuordnungen.
  const [plannerConflicts, duplicates, staleDeals] = await Promise.all([
    detectPlannerConflicts(userId).catch((err) => {
      logger.warn({ err, userId }, 'Planner-Konfliktprüfung fehlgeschlagen');
      return 0;
    }),
    detectDuplicates(userId).catch((err) => {
      logger.warn({ err, userId }, 'Dublettenprüfung fehlgeschlagen');
      return 0;
    }),
    detectStaleDeals(userId, now),
  ]);
  result.conflictCount = plannerConflicts + duplicates + staleDeals;

  await recordRun(userId, now, result);
  logger.info({ userId, ...result }, 'Täglicher Priorisierungslauf abgeschlossen');
  return result;
}

/** Offene Deals ohne nächste Aktion – der häufigste Grund für versandete Vorgänge. */
async function detectStaleDeals(userId: string, now: Date): Promise<number> {
  const threshold = new Date(now.getTime() - 30 * 86400_000);
  const stale = await prisma.deal.findMany({
    where: {
      ownerId: userId,
      stage: { notIn: ['WON', 'LOST', 'ON_HOLD'] },
      OR: [{ nextAction: null }, { nextAction: '' }],
      updatedAt: { lt: threshold },
    },
    select: { id: true, title: true, updatedAt: true },
    take: 50,
  });

  let created = 0;
  for (const deal of stale) {
    const dedupeKey = `stale-deal:${deal.id}`;
    const existing = await prisma.reviewItem.findUnique({
      where: { dedupeKey },
      select: { id: true, status: true },
    });
    if (existing?.status === 'DISMISSED') continue;
    await prisma.reviewItem.upsert({
      where: { dedupeKey },
      create: {
        type: 'STALE_DEAL',
        dedupeKey,
        title: `Deal ohne nächste Aktion: ${deal.title.slice(0, 60)}`,
        detail: `Seit ${deal.updatedAt.toLocaleDateString('de-DE')} keine Änderung und keine nächste Aktion hinterlegt.`,
        userId,
        dealId: deal.id,
      },
      update: { status: 'OPEN' },
    });
    if (!existing) created++;
  }
  return created;
}

async function recordRun(userId: string, now: Date, result: DailyScanResult): Promise<void> {
  const runDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  await prisma.dailyRun.upsert({
    where: { runDate_userId: { runDate, userId } },
    create: {
      runDate,
      userId,
      dealsEvaluated: result.dealsEvaluated,
      followUpCount: result.followUpCount,
      reactivationCount: result.reactivationCount,
      coldOutreachCount: result.coldOutreachCount,
      conflictCount: result.conflictCount,
      finishedAt: new Date(),
    },
    update: {
      dealsEvaluated: result.dealsEvaluated,
      followUpCount: result.followUpCount,
      reactivationCount: result.reactivationCount,
      coldOutreachCount: result.coldOutreachCount,
      conflictCount: result.conflictCount,
      finishedAt: new Date(),
    },
  });
}
