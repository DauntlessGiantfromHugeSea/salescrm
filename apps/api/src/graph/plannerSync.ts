import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { GraphError, graphPaginate } from './client.js';
import type { GraphPlannerTask } from './types.js';

/**
 * Spiegelt Microsoft Planner.
 *
 * Planner ist Steuerungs- und Aufgabenquelle, nie führendes System –
 * bei Widersprüchen gewinnt immer das CRM (Kapitel 12). Deshalb schreiben wir
 * hier nur Aufgabenzustände mit und leiten daraus Konflikte ab, statt Deals zu ändern.
 */
export async function syncPlanner(userId: string): Promise<{ tasks: number; skipped: boolean }> {
  try {
    let count = 0;
    for await (const task of graphPaginate<GraphPlannerTask>(userId, '/me/planner/tasks', {
      maxItems: 2000,
    })) {
      await upsertPlannerTask(userId, task);
      count++;
    }

    await prisma.syncState.upsert({
      where: { userId_resource: { userId, resource: 'planner' } },
      create: { userId, resource: 'planner', lastRunAt: new Date(), itemsSynced: count, backfillDone: true },
      update: { lastRunAt: new Date(), lastError: null, itemsSynced: { increment: count } },
    });

    logger.info({ userId, tasks: count }, 'Planner synchronisiert');
    return { tasks: count, skipped: false };
  } catch (err) {
    // Fehlt die Berechtigung, ist Planner im Tenant schlicht nicht freigegeben.
    // Das System läuft ohne Planner vollständig weiter.
    if (err instanceof GraphError && err.isPermissionDenied) {
      logger.warn({ userId }, 'Planner-Berechtigung fehlt – Synchronisation übersprungen');
      await prisma.syncState.upsert({
        where: { userId_resource: { userId, resource: 'planner' } },
        create: { userId, resource: 'planner', lastRunAt: new Date(), lastError: 'Berechtigung fehlt' },
        update: { lastRunAt: new Date(), lastError: 'Berechtigung fehlt' },
      });
      return { tasks: 0, skipped: true };
    }
    throw err;
  }
}

async function upsertPlannerTask(userId: string, task: GraphPlannerTask): Promise<void> {
  const dueAt = task.dueDateTime ? new Date(task.dueDateTime) : null;
  const completedAt = task.completedDateTime ? new Date(task.completedDateTime) : null;
  const title = task.title ?? 'Unbenannte Aufgabe';

  // Aufgabentitel enthalten in der Praxis die Projektnummer oder den Firmennamen –
  // darüber findet die Aufgabe ihren Deal.
  const dealId = await findDealForTaskTitle(title);

  await prisma.plannerTask.upsert({
    where: { graphTaskId: task.id },
    create: {
      graphTaskId: task.id,
      planId: task.planId ?? '',
      bucketId: task.bucketId ?? null,
      userId,
      dealId,
      title,
      dueAt,
      completedAt,
      percentComplete: task.percentComplete ?? 0,
    },
    update: {
      title,
      dueAt,
      completedAt,
      percentComplete: task.percentComplete ?? 0,
      syncedAt: new Date(),
      ...(dealId ? { dealId } : {}),
    },
  });
}

async function findDealForTaskTitle(title: string): Promise<string | null> {
  // Projektnummern im Format 2026-041 sind das verlässlichste Signal.
  const numberMatch = /\b(\d{4})[-/](\d{2,4})\b/.exec(title);
  if (numberMatch) {
    const number = `${numberMatch[1]}-${numberMatch[2]}`;
    const project = await prisma.project.findFirst({
      where: { number: { equals: number, mode: 'insensitive' } },
      select: { id: true },
    });
    if (project) {
      const deal = await prisma.deal.findFirst({
        where: { projectId: project.id, stage: { notIn: ['WON', 'LOST'] } },
        select: { id: true },
        orderBy: { updatedAt: 'desc' },
      });
      if (deal) return deal.id;
    }
  }
  return null;
}

/**
 * Konflikte zwischen Planner und CRM nach Kapitel 12.
 * Es wird nichts korrigiert – die Fälle landen als Prüfaufgaben in Bucket D.
 */
export async function detectPlannerConflicts(userId: string): Promise<number> {
  const now = new Date();
  let created = 0;

  const orphaned = await prisma.plannerTask.findMany({
    where: {
      userId,
      completedAt: null,
      deal: { stage: { in: ['WON', 'LOST'] } },
    },
    select: { id: true, title: true, dealId: true, deal: { select: { title: true, stage: true } } },
    take: 100,
  });
  for (const task of orphaned) {
    created += await upsertConflict({
      type: 'PLANNER_TASK_ORPHANED',
      dedupeKey: `planner-orphan:${task.id}`,
      title: `Planner-Aufgabe offen, Deal ist ${task.deal?.stage === 'WON' ? 'gewonnen' : 'verloren'}`,
      detail: `Aufgabe „${task.title}" ist offen, der zugehörige Deal „${task.deal?.title}" ist bereits abgeschlossen. Aufgabe in Planner abhaken oder Deal-Status korrigieren.`,
      userId,
      dealId: task.dealId,
    });
  }

  const overdue = await prisma.plannerTask.findMany({
    where: { userId, completedAt: null, dueAt: { lt: now } },
    select: { id: true, title: true, dueAt: true, dealId: true },
    take: 100,
  });
  for (const task of overdue) {
    created += await upsertConflict({
      type: 'PLANNER_TASK_OVERDUE',
      dedupeKey: `planner-overdue:${task.id}`,
      title: `Planner-Aufgabe überfällig: ${task.title.slice(0, 60)}`,
      detail: `Fällig war ${task.dueAt?.toLocaleDateString('de-DE') ?? 'unbekannt'}. Im CRM ist dazu keine neue Aktion hinterlegt.`,
      userId,
      dealId: task.dealId,
    });
  }

  const missing = await prisma.deal.findMany({
    where: { ownerId: userId, stage: 'FOLLOW_UP_DUE', plannerTasks: { none: { completedAt: null } } },
    select: { id: true, title: true },
    take: 100,
  });
  for (const deal of missing) {
    created += await upsertConflict({
      type: 'PLANNER_TASK_MISSING',
      dedupeKey: `planner-missing:${deal.id}`,
      title: `Follow-up fällig, keine Planner-Aufgabe: ${deal.title.slice(0, 60)}`,
      detail: 'Für diesen Deal ist ein Follow-up fällig, in Planner existiert dazu keine offene Aufgabe.',
      userId,
      dealId: deal.id,
    });
  }

  return created;
}

async function upsertConflict(item: {
  type: 'PLANNER_TASK_ORPHANED' | 'PLANNER_TASK_OVERDUE' | 'PLANNER_TASK_MISSING';
  dedupeKey: string;
  title: string;
  detail: string;
  userId: string;
  dealId: string | null;
}): Promise<number> {
  const existing = await prisma.reviewItem.findUnique({
    where: { dedupeKey: item.dedupeKey },
    select: { id: true, status: true },
  });
  // Einmal weggeklickte Konflikte kommen nicht täglich zurück.
  if (existing?.status === 'DISMISSED') return 0;

  await prisma.reviewItem.upsert({
    where: { dedupeKey: item.dedupeKey },
    create: {
      type: item.type,
      dedupeKey: item.dedupeKey,
      title: item.title,
      detail: item.detail,
      userId: item.userId,
      dealId: item.dealId,
    },
    update: { title: item.title, detail: item.detail, status: 'OPEN' },
  });
  return existing ? 0 : 1;
}
