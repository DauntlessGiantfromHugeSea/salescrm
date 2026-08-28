import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/db.js';
import { queue, enqueue } from './queue.js';

/**
 * Wiederkehrende Läufe.
 *
 * BullMQ verwaltet die Zeitpläne selbst in Redis. Beim Start werden die
 * Definitionen abgeglichen: alte Zeitpläne, die nicht mehr in der
 * Konfiguration stehen, werden entfernt – sonst laufen nach einer Änderung
 * heimlich zwei Zeitpläne parallel.
 */

const SCHEDULES = [
  { key: 'nightly-sync', cron: () => config.CRON_NIGHTLY_SYNC, job: 'nightly-sync' },
  { key: 'daily-scan', cron: () => config.CRON_DAILY_SCAN, job: 'daily-scan' },
  { key: 'transcript-fetch', cron: () => config.CRON_TRANSCRIPT_FETCH, job: 'transcript-fetch' },
] as const;

export async function registerSchedules(): Promise<void> {
  const existing = await queue.getJobSchedulers();
  // Ohne Microsoft-Anbindung gibt es nichts zu synchronisieren und keine
  // Transkripte abzuholen. Der tägliche Priorisierungslauf bleibt sinnvoll –
  // er rechnet nur mit dem, was in der Datenbank steht.
  const active = config.hasMicrosoft ? SCHEDULES : SCHEDULES.filter((s) => s.key === 'daily-scan');
  const wanted = new Set(active.map((s) => s.key));

  for (const scheduler of existing) {
    if (scheduler.key && !wanted.has(scheduler.key as never)) {
      await queue.removeJobScheduler(scheduler.key);
      logger.info({ key: scheduler.key }, 'Veralteten Zeitplan entfernt');
    }
  }

  for (const schedule of active) {
    await queue.upsertJobScheduler(
      schedule.key,
      { pattern: schedule.cron(), tz: 'UTC' },
      { name: schedule.job, data: {} },
    );
  }

  logger.info(
    {
      nightlySync: config.CRON_NIGHTLY_SYNC,
      dailyScan: config.CRON_DAILY_SCAN,
      transcripts: config.CRON_TRANSCRIPT_FETCH,
    },
    'Zeitpläne registriert',
  );
}

/**
 * Der nächtliche Lauf fächert in Einzeljobs auf: ein Job je Postfach und
 * je Benutzer. Fällt ein Postfach aus, laufen die anderen trotzdem durch.
 */
export async function fanOutNightlySync(): Promise<{ mailboxes: number; users: number }> {
  const mailboxes = await prisma.mailbox.findMany({
    where: { syncEnabled: true, ownerUserId: { not: null } },
    select: { id: true },
  });
  for (const mailbox of mailboxes) {
    await enqueue('mailbox.sync', { mailboxId: mailbox.id }, { jobId: `mailbox-sync:${mailbox.id}` });
  }

  const users = await prisma.user.findMany({
    where: { active: true, msAccount: { isNot: null } },
    select: { id: true },
  });
  for (const user of users) {
    await enqueue('user.sync', { userId: user.id }, { jobId: `user-sync:${user.id}` });
  }

  logger.info({ mailboxes: mailboxes.length, users: users.length }, 'Nächtlicher Lauf verteilt');
  return { mailboxes: mailboxes.length, users: users.length };
}

export async function fanOutDailyScan(): Promise<number> {
  const users = await prisma.user.findMany({ where: { active: true }, select: { id: true } });
  const day = new Date().toISOString().slice(0, 10);
  for (const user of users) {
    await enqueue('daily.scan', { userId: user.id }, { jobId: `daily-scan:${user.id}:${day}` });
  }
  return users.length;
}
