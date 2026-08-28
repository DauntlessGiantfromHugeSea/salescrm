import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * Hintergrundarbeit läuft über BullMQ, nicht über einen Timer im Webserver.
 *
 * Der Grund ist praktisch: der nächtliche Erstimport eines großen Postfachs
 * läuft stundenlang. In einem Webprozess würde er jeden Neustart und jedes
 * Deployment nicht überleben und Anfragen blockieren.
 */
export const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const QUEUE_NAME = 'salescrm';

export type JobName =
  | 'mailbox.sync'
  | 'user.sync'
  | 'daily.scan'
  | 'draft.generate'
  | 'transcript.fetch'
  | 'activity.classify'
  | 'mailbox.discover';

export interface JobPayloads {
  'mailbox.sync': { mailboxId: string };
  'user.sync': { userId: string };
  'daily.scan': { userId: string };
  'draft.generate': { dealId: string; type: 'FOLLOW_UP' | 'REACTIVATION' | 'COLD_OUTREACH'; userId: string };
  'transcript.fetch': Record<string, never>;
  'activity.classify': { activityId: string };
  'mailbox.discover': Record<string, never>;
}

export const queue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 7 * 86400, count: 1000 },
    removeOnFail: { age: 30 * 86400 },
  },
});

export async function enqueue<T extends JobName>(
  name: T,
  data: JobPayloads[T],
  options: { jobId?: string; delay?: number; priority?: number } = {},
): Promise<void> {
  await queue.add(name, data, options);
}

/**
 * Der Postfach-Sync bekommt eine feste Job-ID pro Postfach. BullMQ lehnt einen
 * zweiten Job mit derselben ID ab – so kann ein ungeduldiger Klick im Dashboard
 * nicht drei parallele Importe desselben Postfachs starten.
 */
export async function enqueueMailboxSync(mailboxId: string): Promise<void> {
  await enqueue('mailbox.sync', { mailboxId }, { jobId: `mailbox-sync:${mailboxId}` });
}

export async function enqueueUserSync(userId: string): Promise<void> {
  await enqueue('user.sync', { userId }, { jobId: `user-sync:${userId}` });
}

export async function enqueueDailyScan(userId: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  await enqueue('daily.scan', { userId }, { jobId: `daily-scan:${userId}:${day}` });
}

export async function enqueueClassification(activityId: string): Promise<void> {
  await enqueue('activity.classify', { activityId }, { jobId: `classify:${activityId}`, priority: 10 });
}

export async function closeQueue(): Promise<void> {
  await queue.close();
  await connection.quit();
}
