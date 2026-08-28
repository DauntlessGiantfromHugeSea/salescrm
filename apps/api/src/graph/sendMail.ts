import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { graphRequest } from './client.js';
import { audit } from '../lib/audit.js';

/**
 * Versand einer freigegebenen Mail aus dem echten Postfach des Bearbeiters.
 *
 * Diese Funktion ist die einzige Stelle im System, die eine Mail nach außen
 * schickt. Sie prüft selbst nach, dass der Entwurf freigegeben ist – auch wenn
 * die Route das bereits getan hat. Ein automatischer Versand darf nicht durch
 * einen einzelnen Fehler in einer Route entstehen.
 */
export class DraftNotApprovedError extends Error {
  constructor(status: string) {
    super(`Entwurf hat den Status ${status} und ist nicht freigegeben`);
    this.name = 'DraftNotApprovedError';
  }
}

export async function sendApprovedDraft(draftId: string, ip?: string): Promise<{ sentAt: Date }> {
  const draft = await prisma.emailDraft.findUnique({
    where: { id: draftId },
    include: {
      deal: { select: { id: true, projectId: true, stage: true } },
      user: { select: { id: true, displayName: true } },
    },
  });
  if (!draft) throw new Error('Entwurf nicht gefunden');

  if (draft.status !== 'APPROVED') {
    throw new DraftNotApprovedError(draft.status);
  }

  // Statuswechsel als Sperre: ein zweiter paralleler Aufruf findet den Entwurf
  // nicht mehr im Zustand APPROVED und kann die Mail nicht ein zweites Mal senden.
  const claimed = await prisma.emailDraft.updateMany({
    where: { id: draftId, status: 'APPROVED' },
    data: { status: 'SENDING' },
  });
  if (claimed.count === 0) {
    throw new DraftNotApprovedError('bereits in Versand');
  }

  try {
    await graphRequest(draft.userId, '/me/sendMail', {
      method: 'POST',
      body: {
        message: {
          subject: draft.subject,
          body: { contentType: 'HTML', content: toHtml(draft.body) },
          toRecipients: [
            { emailAddress: { address: draft.toEmail, ...(draft.toName ? { name: draft.toName } : {}) } },
          ],
          ccRecipients: draft.ccEmails.map((email) => ({ emailAddress: { address: email } })),
        },
        // Die Mail landet im Postfach unter "Gesendete Elemente" –
        // der Bearbeiter sieht in Outlook, was in seinem Namen rausging.
        saveToSentItems: true,
      },
    });

    const sentAt = new Date();

    await prisma.$transaction([
      prisma.emailDraft.update({
        where: { id: draftId },
        data: { status: 'SENT', sentAt, error: null },
      }),
      prisma.activity.create({
        data: {
          occurredAt: sentAt,
          direction: 'OUTBOUND',
          channel: 'EMAIL',
          subject: draft.subject,
          bodyPreview: draft.body.slice(0, 4000),
          replyPending: true,
          dealId: draft.dealId,
          projectId: draft.deal.projectId,
          userId: draft.userId,
        },
      }),
      prisma.deal.update({
        where: { id: draft.dealId },
        data: {
          lastOutboundAt: sentAt,
          lastContactAt: sentAt,
          // Nach dem Versand wartet der Vorgang auf Antwort. Fortgeschrittene
          // Stufen bleiben unangetastet.
          ...(['NEW', 'OPEN', 'FOLLOW_UP_DUE'].includes(draft.deal.stage)
            ? { stage: 'AWAITING_REPLY' as const }
            : {}),
        },
      }),
    ]);

    await audit({
      userId: draft.userId,
      action: 'email.sent',
      entityType: 'EmailDraft',
      entityId: draftId,
      detail: { to: draft.toEmail, subject: draft.subject, dealId: draft.dealId },
      ip,
    });

    logger.info({ draftId, to: draft.toEmail }, 'Mail versendet');
    return { sentAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.emailDraft.update({
      where: { id: draftId },
      data: { status: 'FAILED', error: message.slice(0, 1000) },
    });
    await audit({
      userId: draft.userId,
      action: 'email.send_failed',
      entityType: 'EmailDraft',
      entityId: draftId,
      detail: { error: message.slice(0, 500) },
      ip,
    });
    logger.error({ err, draftId }, 'Versand fehlgeschlagen');
    throw err;
  }
}

/**
 * Wandelt den Klartext des Entwurfs in schlichtes HTML.
 * Bewusst ohne Stile: die Mail soll aussehen, als hätte sie ein Mensch in
 * Outlook geschrieben, und die Signatur des Postfachs wird angehängt.
 */
function toHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}
