import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { graphDelta, graphPaginate, graphRequest, GraphError, type GraphActor } from './client.js';
import { actorForMailbox, foldersFor } from './mailboxRegistry.js';
import type { Mailbox } from '@prisma/client';
import type { GraphAttachmentMeta, GraphMessage, GraphRecipient } from './types.js';
import {
  htmlToText,
  parseSignature,
  splitSignature,
  stripQuotedReply,
  truncate,
} from '../domain/parsing.js';
import { isEligibleContact, isInternalAddress, upsertContact } from '../domain/upsert.js';
import { linkActivityToProject, noteProjectParticipant } from '../domain/projectLinking.js';

/**
 * Felder, die wir von Graph anfordern. Bewusst ohne `body` im Delta-Lauf:
 * die Bodies machen den Löwenanteil der Übertragungsmenge aus und werden
 * nur für relevante Nachrichten einzeln nachgeladen.
 */
const MESSAGE_SELECT =
  'id,internetMessageId,conversationId,subject,bodyPreview,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,isDraft,parentFolderId';

/** Wie viel Klartext je Mail gespeichert wird. Reicht als KI-Kontext, sprengt keine Datenbank. */
const BODY_PREVIEW_LIMIT = 4000;

export interface MailSyncResult {
  mailbox: string;
  folder: string;
  messagesProcessed: number;
  activitiesCreated: number;
  contactsTouched: number;
  deltaLink: string | null;
  reachedLimit: boolean;
}

/**
 * Synchronisiert alle konfigurierten Ordner eines Firmenpostfachs.
 */
export async function syncMailbox(
  mailbox: Mailbox,
  options: { maxMessagesPerFolder?: number } = {},
): Promise<MailSyncResult[]> {
  const actor = await actorForMailbox(mailbox);
  const results: MailSyncResult[] = [];

  for (const folder of foldersFor(mailbox)) {
    try {
      results.push(
        await syncMailFolder(mailbox, actor, folder, { maxMessages: options.maxMessagesPerFolder }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, mailbox: mailbox.address, folder }, 'Ordner konnte nicht synchronisiert werden');
      await prisma.mailbox.update({
        where: { id: mailbox.id },
        data: { lastError: message.slice(0, 500) },
      });
    }
  }

  const totalMessages = results.reduce((sum, r) => sum + r.messagesProcessed, 0);
  const allDone = results.every((r) => !r.reachedLimit);
  await prisma.mailbox.update({
    where: { id: mailbox.id },
    data: {
      lastSyncAt: new Date(),
      messagesSynced: { increment: totalMessages },
      ...(allDone ? { initialImportDone: true, lastError: null } : {}),
    },
  });

  return results;
}

/**
 * Synchronisiert einen Mailordner eines Postfachs.
 *
 * Der Ablauf ist dreistufig, weil Graph auf dem Delta-Endpunkt für Nachrichten
 * **kein `$filter` unterstützt**. Ein naiver Delta-Erstlauf würde deshalb das
 * gesamte Postfach durchlaufen statt der konfigurierten 24 Monate:
 *
 *  1. Nachladen (`backfill`): gewöhnliche gefilterte Abfrage rückwärts durch
 *     die Zeit, in Blöcken. Nur hier werden Inhalte geholt.
 *  2. Delta aufsetzen: einmalig durch den Ordner blättern und dabei nur `id`
 *     anfordern – das ist billig und liefert den `deltaLink`.
 *  3. Laufender Betrieb: Delta-Abfrage, die nur noch Änderungen liefert.
 */
export async function syncMailFolder(
  mailbox: Mailbox,
  actor: GraphActor,
  folder: string,
  options: { maxMessages?: number } = {},
): Promise<MailSyncResult> {
  const maxMessages = options.maxMessages ?? 2000;
  const resource = `mail:${folder}`;
  const state = await prisma.syncState.findUnique({
    where: { mailboxId_resource: { mailboxId: mailbox.id, resource } },
  });

  const result: MailSyncResult = {
    mailbox: mailbox.address,
    folder,
    messagesProcessed: 0,
    activitiesCreated: 0,
    contactsTouched: 0,
    deltaLink: null,
    reachedLimit: false,
  };

  const since = new Date();
  since.setMonth(since.getMonth() - config.IMPORT_MONTHS_BACK);

  let messages: GraphMessage[];
  let nextBackfillCursor: Date | null = state?.backfillCursor ?? null;
  let backfillDone = state?.backfillDone ?? false;

  if (state?.deltaLink) {
    const delta = await graphDelta<GraphMessage>(actor, state.deltaLink, { maxItems: maxMessages });
    messages = delta.items;
    result.deltaLink = delta.deltaLink;
  } else if (!backfillDone) {
    // Rückwärts durch die Zeit: der Cursor steht auf der ältesten bereits
    // verarbeiteten Nachricht, der nächste Block holt alles davor.
    const upperBound = state?.backfillCursor ?? new Date();
    const path =
      `/me/mailFolders/${encodeURIComponent(folder)}/messages` +
      `?$select=${MESSAGE_SELECT}` +
      `&$filter=receivedDateTime ge ${since.toISOString()} and receivedDateTime lt ${upperBound.toISOString()}` +
      `&$orderby=receivedDateTime desc` +
      `&$top=100`;

    messages = [];
    for await (const message of graphPaginate<GraphMessage>(actor, path, { maxItems: maxMessages })) {
      messages.push(message);
    }

    // Weniger als ein voller Block bedeutet: der Zeitraum ist abgearbeitet.
    backfillDone = messages.length < maxMessages;
    const oldest = messages.at(-1)?.receivedDateTime;
    if (oldest) {
      // Eine Millisekunde Überlappung: der Filter ist strikt (`lt`), und zwei
      // Nachrichten können denselben Zeitstempel tragen. Lieber eine Nachricht
      // doppelt sehen – die Übernahme ist über die Graph-ID idempotent – als
      // sie an der Blockgrenze zu verlieren.
      nextBackfillCursor = new Date(new Date(oldest).getTime() + 1);
    }

    if (backfillDone) {
      // Erst jetzt den Delta-Link aufsetzen, damit der laufende Betrieb
      // nur noch Änderungen sieht.
      result.deltaLink = await initializeDeltaLink(actor, folder);
    }
  } else {
    // Nachladen war fertig, aber der Delta-Link fehlt (z. B. abgelaufen).
    result.deltaLink = await initializeDeltaLink(actor, folder);
    messages = [];
  }

  // Beim Nachladen zählt ein voller Block als "es kommt noch mehr";
  // im Delta-Betrieb heißt dasselbe, dass die Obergrenze gegriffen hat.
  result.reachedLimit = !backfillDone || messages.length >= maxMessages;
  const isSentFolder = folder.toLowerCase().includes('sent');

  for (const message of messages) {
    if (message['@removed']) continue;
    if (message.isDraft) continue;
    result.messagesProcessed++;

    try {
      const created = await ingestMessage(mailbox, actor, message, isSentFolder);
      if (created.activityCreated) result.activitiesCreated++;
      result.contactsTouched += created.contactsTouched;
    } catch (err) {
      logger.warn({ err, messageId: message.id }, 'Nachricht konnte nicht importiert werden');
    }
  }

  await prisma.syncState.upsert({
    where: { mailboxId_resource: { mailboxId: mailbox.id, resource } },
    create: {
      mailboxId: mailbox.id,
      resource,
      deltaLink: result.deltaLink,
      backfillCursor: nextBackfillCursor,
      backfillDone,
      lastRunAt: new Date(),
      itemsSynced: result.messagesProcessed,
    },
    update: {
      // Einen vorhandenen Delta-Link nicht durch null überschreiben.
      ...(result.deltaLink ? { deltaLink: result.deltaLink } : {}),
      backfillCursor: nextBackfillCursor,
      backfillDone,
      lastRunAt: new Date(),
      lastError: null,
      itemsSynced: { increment: result.messagesProcessed },
    },
  });

  logger.info({ ...result }, 'Mailordner synchronisiert');
  return result;
}

interface IngestResult {
  activityCreated: boolean;
  contactsTouched: number;
}

/**
 * Übernimmt eine einzelne Nachricht in Kontakt, Firma und Aktivität.
 * Anhänge werden ausschließlich als Metadaten geführt – Kapitel 11 schließt
 * PDF-Inhalte für Phase 1 ausdrücklich aus.
 */
async function ingestMessage(
  mailbox: Mailbox,
  actor: GraphActor,
  message: GraphMessage,
  isSentFolder: boolean,
): Promise<IngestResult> {
  // Deals aus einem gemeinsamen Postfach gehören dem fachlich Zuständigen.
  // Ist keiner hinterlegt, bleibt das Postfach ohne Owner und die Zuordnung
  // erfolgt später im Dashboard.
  const ownerId = mailbox.ownerUserId;
  const existing = await prisma.activity.findUnique({
    where: { graphMessageId: message.id },
    select: { id: true },
  });
  if (existing) return { activityCreated: false, contactsTouched: 0 };

  const direction = isSentFolder ? 'OUTBOUND' : 'INBOUND';
  const occurredAt = new Date(
    (isSentFolder ? message.sentDateTime : message.receivedDateTime) ??
      message.receivedDateTime ??
      Date.now(),
  );

  // Der Geschäftspartner ist bei eingehenden Mails der Absender,
  // bei ausgehenden der erste externe Empfänger.
  const counterpartyAddresses = isSentFolder
    ? extractAddresses(message.toRecipients)
    : extractAddresses([message.from ?? message.sender].filter(Boolean) as GraphRecipient[]);

  const externalAddresses = counterpartyAddresses.filter(
    (a) => isEligibleContact(a.address) && !isInternalAddress(a.address),
  );
  if (externalAddresses.length === 0) {
    return { activityCreated: false, contactsTouched: 0 };
  }

  const primary = externalAddresses[0]!;

  // Volltext nur für externe Geschäftsmails nachladen.
  const bodyText = await loadBodyText(actor, message);
  const withoutQuote = stripQuotedReply(bodyText);
  const { body, signature } = splitSignature(withoutQuote);
  const signatureData = signature ? parseSignature(signature) : null;

  if (!ownerId) {
    logger.debug({ mailbox: mailbox.address }, 'Postfach ohne zuständigen Kollegen – Mail wird übersprungen');
    return { activityCreated: false, contactsTouched: 0 };
  }

  const contact = await upsertContact({
    email: primary.address,
    displayName: primary.name,
    // Signaturdaten nur aus eingehenden Mails übernehmen –
    // in eigenen Mails steht die eigene Signatur.
    phone: isSentFolder ? null : signatureData?.phone ?? null,
    position: isSentFolder ? null : signatureData?.position ?? null,
    companyName: isSentFolder ? null : signatureData?.companyName ?? null,
    website: isSentFolder ? null : signatureData?.website ?? null,
    ownerId,
    source: 'OUTLOOK',
  });
  if (!contact) return { activityCreated: false, contactsTouched: 0 };

  const attachments = message.hasAttachments ? await loadAttachmentMeta(actor, message.id) : [];
  const attachmentNames = attachments.map((a) => a.name ?? 'unbenannt');
  const hasPdf = attachmentNames.some((n) => n.toLowerCase().endsWith('.pdf'));

  const deal = await findDealForMessage(contact.id, message.conversationId ?? null);

  const activityData: Prisma.ActivityCreateInput = {
    occurredAt,
    direction,
    channel: 'EMAIL',
    subject: message.subject ?? null,
    bodyPreview: truncate(body || message.bodyPreview || '', BODY_PREVIEW_LIMIT),
    replyPending: direction === 'OUTBOUND',
    attachmentNames,
    hasPdfAttachment: hasPdf,
    graphMessageId: message.id,
    internetMessageId: message.internetMessageId ?? null,
    conversationId: message.conversationId ?? null,
    user: { connect: { id: ownerId } },
    mailbox: { connect: { id: mailbox.id } },
    contact: { connect: { id: contact.id } },
    ...(deal ? { deal: { connect: { id: deal.id } } } : {}),
  };

  const activity = await prisma.$transaction(async (tx) => {
    const created = await tx.activity.create({ data: activityData });

    await tx.contact.update({
      where: { id: contact.id },
      data: {
        emailCount: { increment: 1 },
        ...(direction === 'INBOUND' ? { lastInboundAt: occurredAt } : { lastOutboundAt: occurredAt }),
      },
    });

    if (deal) {
      await tx.deal.update({
        where: { id: deal.id },
        data: {
          lastContactAt: occurredAt,
          ...(direction === 'INBOUND'
            ? { lastInboundAt: occurredAt }
            : { lastOutboundAt: occurredAt }),
        },
      });
      // Eine eingehende Antwort erledigt die Wartemarkierung der letzten Ausgangsmail.
      if (direction === 'INBOUND' && message.conversationId) {
        await tx.activity.updateMany({
          where: { conversationId: message.conversationId, direction: 'OUTBOUND', replyPending: true },
          data: { replyPending: false },
        });
      }
    }

    return created;
  });

  // Projektzuordnung nach dem Schreiben: sie darf die Mail-Übernahme nie
  // blockieren – eine nicht zugeordnete Mail ist immer noch eine importierte Mail.
  try {
    const allParticipants = [
      ...extractAddresses(message.toRecipients),
      ...extractAddresses(message.ccRecipients),
      ...extractAddresses([message.from ?? message.sender].filter(Boolean) as GraphRecipient[]),
    ].map((a) => a.address);

    const result = await linkActivityToProject({
      activityId: activity.id,
      subject: message.subject ?? '',
      bodyPreview: activity.bodyPreview ?? '',
      participantEmails: allParticipants,
      conversationId: message.conversationId ?? null,
      dealId: deal?.id ?? null,
      userId: ownerId,
    });

    if (result.match) {
      // Wer in einer eindeutig zugeordneten Projektmail steht, ist am Projekt beteiligt.
      await noteProjectParticipant({
        projectId: result.match.projectId,
        contactId: contact.id,
        occurredAt,
      });
    }
  } catch (err) {
    logger.warn({ err, activityId: activity.id }, 'Projektzuordnung fehlgeschlagen');
  }

  return { activityCreated: true, contactsTouched: 1 };
}

/** Lädt den Mailtext einzeln nach und wandelt HTML in Klartext. */
async function loadBodyText(actor: GraphActor, message: GraphMessage): Promise<string> {
  if (message.body?.content) {
    return message.body.contentType?.toLowerCase() === 'html'
      ? htmlToText(message.body.content)
      : message.body.content;
  }
  try {
    const full = await graphRequest<GraphMessage>(
      actor,
      `/me/messages/${message.id}?$select=body,bodyPreview`,
      { tolerateNotFound: true },
    );
    if (!full?.body?.content) return message.bodyPreview ?? '';
    return full.body.contentType?.toLowerCase() === 'html'
      ? htmlToText(full.body.content)
      : full.body.content;
  } catch (err) {
    if (err instanceof GraphError && err.isNotFound) return message.bodyPreview ?? '';
    logger.debug({ err, messageId: message.id }, 'Mailtext nicht ladbar, Vorschau wird genutzt');
    return message.bodyPreview ?? '';
  }
}

/**
 * Holt ausschließlich die Anhangs-Metadaten.
 * `$select` ohne contentBytes ist der Grund, warum aus 150 GB Archiv
 * nur die 10–20 GB Textanteil über die Leitung gehen.
 */
async function loadAttachmentMeta(actor: GraphActor, messageId: string): Promise<GraphAttachmentMeta[]> {
  try {
    const items: GraphAttachmentMeta[] = [];
    for await (const attachment of graphPaginate<GraphAttachmentMeta>(
      actor,
      `/me/messages/${messageId}/attachments?$select=id,name,contentType,size`,
      { maxItems: 25 },
    )) {
      items.push(attachment);
    }
    return items;
  } catch (err) {
    logger.debug({ err, messageId }, 'Anhangsliste nicht abrufbar');
    return [];
  }
}

/**
 * Ordnet eine Nachricht einem bestehenden Deal zu.
 * Zuerst über die Konversation (zuverlässig), sonst über den aktiven Deal
 * des Kontakts. Gibt es mehrere aktive Deals, bleibt die Zuordnung offen und
 * landet als Prüfaufgabe in Bucket D.
 */
async function findDealForMessage(
  contactId: string,
  conversationId: string | null,
): Promise<{ id: string } | null> {
  if (conversationId) {
    const viaThread = await prisma.activity.findFirst({
      where: { conversationId, dealId: { not: null } },
      select: { dealId: true },
      orderBy: { occurredAt: 'desc' },
    });
    if (viaThread?.dealId) return { id: viaThread.dealId };
  }

  const openDeals = await prisma.deal.findMany({
    where: { contactId, stage: { notIn: ['WON', 'LOST'] } },
    select: { id: true },
    orderBy: { updatedAt: 'desc' },
    take: 2,
  });
  if (openDeals.length === 1) return openDeals[0]!;
  return null;
}

function extractAddresses(recipients: GraphRecipient[] | undefined): Array<{ address: string; name: string | null }> {
  return (recipients ?? [])
    .map((r) => ({
      address: (r.emailAddress?.address ?? '').toLowerCase().trim(),
      name: r.emailAddress?.name ?? null,
    }))
    .filter((r) => r.address.includes('@'));
}


/**
 * Setzt den Delta-Link für einen Ordner auf.
 *
 * Graph liefert einen `deltaLink` erst, wenn man einmal vollständig durch den
 * Ordner geblättert hat. Das ist der Grund für `$select=id`: die Nachrichten
 * selbst interessieren hier nicht, sie wurden beim Nachladen bereits geholt.
 * Ohne die Einschränkung würde dieser Durchlauf das halbe Postfach übertragen.
 */
async function initializeDeltaLink(actor: GraphActor, folder: string): Promise<string | null> {
  const path = `/me/mailFolders/${encodeURIComponent(folder)}/messages/delta?$select=id&$top=500`;
  try {
    const { deltaLink } = await graphDelta<{ id: string }>(actor, path, { maxItems: 200_000 });
    return deltaLink;
  } catch (err) {
    // Ohne Delta-Link läuft der nächste Lauf erneut hier vorbei – das kostet
    // Zeit, aber es gehen keine Nachrichten verloren.
    logger.warn({ err, folder }, 'Delta-Link konnte nicht aufgesetzt werden');
    return null;
  }
}
