import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/db.js';
import { QUEUE_NAME, connection, type JobPayloads } from './queue.js';
import { syncMailbox } from '../graph/mailSync.js';
import { syncContacts } from '../graph/contactSync.js';
import { syncCalendar } from '../graph/calendarSync.js';
import { syncPlanner } from '../graph/plannerSync.js';
import { syncMailboxRegistry } from '../graph/mailboxRegistry.js';
import { runDailyScan } from '../domain/dailyScan.js';
import { generateDraft, classifyActivity, summarizeMeeting } from '../ai/drafts.js';
import { fetchMeetingTranscript } from '../graph/teams.js';
import { classifyBucket } from '@salescrm/shared';

/**
 * Verarbeitet die Hintergrundaufgaben. Läuft als eigener Prozess neben der API,
 * damit ein langer Import keine Anfrage blockiert.
 */
export function createWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      switch (job.name) {
        case 'mailbox.sync':
          return handleMailboxSync(job.data as JobPayloads['mailbox.sync']);
        case 'user.sync':
          return handleUserSync(job.data as JobPayloads['user.sync']);
        case 'daily.scan':
          return handleDailyScan(job.data as JobPayloads['daily.scan']);
        case 'draft.generate':
          return handleDraftGenerate(job.data as JobPayloads['draft.generate']);
        case 'transcript.fetch':
          return handleTranscriptFetch();
        case 'activity.classify':
          return handleClassify(job.data as JobPayloads['activity.classify']);
        case 'mailbox.discover':
          return syncMailboxRegistry();
        default:
          logger.warn({ name: job.name }, 'Unbekannter Job');
          return null;
      }
    },
    {
      connection,
      // Graph drosselt pro Postfach; mehr Parallelität bringt keinen Durchsatz,
      // sondern nur mehr 429-Antworten.
      concurrency: 3,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id, name: job?.name, attempts: job?.attemptsMade }, 'Job fehlgeschlagen');
  });
  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, name: job.name }, 'Job erledigt');
  });

  return worker;
}

async function handleMailboxSync(data: JobPayloads['mailbox.sync']): Promise<unknown> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: data.mailboxId } });
  if (!mailbox) {
    logger.warn({ mailboxId: data.mailboxId }, 'Postfach nicht mehr vorhanden');
    return null;
  }
  if (!mailbox.syncEnabled) {
    logger.debug({ address: mailbox.address }, 'Postfach ist deaktiviert');
    return null;
  }

  // Beim Erstimport in größeren Blöcken arbeiten, danach reichen kleine Deltas.
  const maxMessagesPerFolder = mailbox.initialImportDone ? 500 : 2000;
  const results = await syncMailbox(mailbox, { maxMessagesPerFolder });

  // Der Erstimport ist noch nicht durch: gleich weiterlaufen lassen,
  // statt bis zur nächsten Nacht zu warten.
  if (results.some((r) => r.reachedLimit)) {
    const { enqueue } = await import('./queue.js');
    await enqueue('mailbox.sync', { mailboxId: mailbox.id }, { delay: 60_000 });
  }

  return results;
}

/** Kontakte, Kalender und Planner hängen an der Person, nicht am Postfach. */
async function handleUserSync(data: JobPayloads['user.sync']): Promise<unknown> {
  const account = await prisma.msAccount.findUnique({ where: { userId: data.userId } });
  if (!account) {
    logger.debug({ userId: data.userId }, 'Kein verbundenes Microsoft-Konto');
    return null;
  }

  const results: Record<string, unknown> = {};

  for (const [name, task] of [
    ['contacts', () => syncContacts(data.userId)],
    ['calendar', () => syncCalendar(data.userId)],
    ['planner', () => syncPlanner(data.userId)],
  ] as const) {
    try {
      results[name] = await task();
    } catch (err) {
      // Ein fehlgeschlagener Teilbereich darf die anderen nicht mitreißen.
      logger.error({ err, userId: data.userId, area: name }, 'Teilsynchronisation fehlgeschlagen');
      results[name] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return results;
}

async function handleDailyScan(data: JobPayloads['daily.scan']): Promise<unknown> {
  const result = await runDailyScan(data.userId);

  if (config.AUTO_GENERATE_FOLLOWUP_DRAFTS) {
    await generateFollowUpDrafts(data.userId);
  }

  return result;
}

/**
 * Erzeugt Entwürfe für die dringendsten Follow-ups im Voraus, damit die
 * Tagesübersicht morgens fertig ist statt beim Aufklappen zu laden.
 * Die Obergrenze ist eine Kostenbremse.
 */
async function generateFollowUpDrafts(userId: string): Promise<void> {
  const candidates = await prisma.deal.findMany({
    where: {
      ownerId: userId,
      isOpen: true,
      stage: { notIn: ['WON', 'LOST', 'ON_HOLD'] },
      contactId: { not: null },
      contact: { optedOut: false },
      // Kein zweiter Entwurf, solange einer offen ist.
      drafts: { none: { status: { in: ['DRAFT', 'EDITED', 'APPROVED'] } } },
    },
    select: {
      id: true,
      lastOutboundAt: true,
      lastInboundAt: true,
      relevance: true,
    },
    orderBy: [{ relevance: 'asc' }, { lastContactAt: 'asc' }],
    take: config.MAX_AUTO_DRAFTS_PER_RUN,
  });

  for (const deal of candidates) {
    const bucket = classifyBucket(
      { lastOutboundAt: deal.lastOutboundAt, lastInboundAt: deal.lastInboundAt },
      config.ruleConfig,
    );
    // Nur Follow-ups und Reaktivierungen vorproduzieren. Kaltakquise braucht
    // eine bewusste Entscheidung, welche Firma überhaupt angeschrieben wird.
    if (bucket === 'C_COLD_OUTREACH') continue;

    try {
      await generateDraft({
        dealId: deal.id,
        type: bucket === 'A_FOLLOW_UP' ? 'FOLLOW_UP' : 'REACTIVATION',
        userId,
      });
    } catch (err) {
      logger.warn({ err, dealId: deal.id }, 'Automatischer Entwurf fehlgeschlagen');
    }
  }
}

async function handleDraftGenerate(data: JobPayloads['draft.generate']): Promise<unknown> {
  return generateDraft({ dealId: data.dealId, type: data.type, userId: data.userId });
}

/**
 * Holt Transkripte abgelaufener Besprechungen und fasst sie zusammen.
 * Microsoft stellt Transkripte mit Verzögerung bereit, deshalb wird ein
 * Termin über mehrere Stunden hinweg wiederholt geprüft.
 */
async function handleTranscriptFetch(): Promise<{ processed: number; summarized: number }> {
  const since = new Date(Date.now() - 48 * 3600_000);
  const meetings = await prisma.meeting.findMany({
    where: {
      transcriptFetchedAt: null,
      status: { in: ['SCHEDULED', 'HELD'] },
      endsAt: { lt: new Date(Date.now() - 10 * 60_000), gt: since },
    },
    select: { id: true },
    take: 50,
  });

  let summarized = 0;
  for (const meeting of meetings) {
    try {
      const fetched = await fetchMeetingTranscript(meeting.id);
      if (fetched) {
        await summarizeMeeting(meeting.id);
        summarized++;
      }
    } catch (err) {
      logger.warn({ err, meetingId: meeting.id }, 'Transkriptverarbeitung fehlgeschlagen');
    }
  }

  // Termine ohne Transkript nach der Frist als stattgefunden markieren,
  // damit sie nicht ewig erneut geprüft werden.
  await prisma.meeting.updateMany({
    where: { status: 'SCHEDULED', endsAt: { lt: since } },
    data: { status: 'HELD' },
  });

  return { processed: meetings.length, summarized };
}

async function handleClassify(data: JobPayloads['activity.classify']): Promise<void> {
  await classifyActivity(data.activityId);
}
