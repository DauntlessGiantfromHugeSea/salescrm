import type { Mailbox } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { GraphError, graphPaginate, type GraphActor } from './client.js';
import { isAppOnlyEnabled } from '../auth/appToken.js';

/**
 * Verwaltet die Postfächer, die das System durchsucht.
 *
 * Ein persönliches Postfach wird delegiert gelesen, sobald sich sein Inhaber
 * anmeldet. Gemeinsame Postfächer (info@, angebote@, projekte@) und die
 * Postfächer von Kollegen, die sich nicht selbst anmelden, laufen über die
 * Anwendungsidentität.
 */

interface DiscoveredMailbox {
  address: string;
  displayName: string;
  kind: 'USER' | 'SHARED';
  graphUserId: string | null;
}

/**
 * Liest alle Postfächer des Tenants, auf die die App zugreifen darf.
 *
 * Die Reichweite begrenzt die ApplicationAccessPolicy im Exchange: Graph
 * listet zwar alle Benutzer auf, der Postfachzugriff scheitert aber für alle
 * außerhalb der freigegebenen Gruppe. Deshalb wird jedes gefundene Postfach
 * einmal angetestet, bevor es aktiviert wird.
 */
export async function discoverMailboxes(): Promise<DiscoveredMailbox[]> {
  if (!isAppOnlyEnabled()) return [];

  const found: DiscoveredMailbox[] = [];
  const actor: GraphActor = { appOnly: true, mailbox: '' };

  // Benutzerpostfächer.
  for await (const user of graphPaginate<{
    id: string;
    displayName?: string;
    mail?: string;
    userPrincipalName?: string;
    accountEnabled?: boolean;
  }>(
    { ...actor, mailbox: '' },
    "/users?$select=id,displayName,mail,userPrincipalName,accountEnabled&$filter=accountEnabled eq true&$top=100",
    { maxItems: 500 },
  )) {
    const address = (user.mail ?? user.userPrincipalName ?? '').toLowerCase();
    if (!address.includes('@')) continue;
    found.push({
      address,
      displayName: user.displayName ?? address,
      kind: 'USER',
      graphUserId: user.id,
    });
  }

  return found;
}

/**
 * Prüft, ob die App ein Postfach tatsächlich lesen darf.
 * Ein 403 heißt hier nicht „kaputt", sondern „von der Zugriffsrichtlinie
 * bewusst ausgeschlossen" – genau das gewünschte Verhalten.
 */
export async function canReadMailbox(address: string): Promise<boolean> {
  try {
    for await (const _ of graphPaginate<unknown>(
      { appOnly: true, mailbox: address },
      '/me/mailFolders?$top=1',
      { maxItems: 1 },
    )) {
      return true;
    }
    return true;
  } catch (err) {
    if (err instanceof GraphError && (err.isPermissionDenied || err.isNotFound)) return false;
    throw err;
  }
}

/** Legt ein Postfach an oder aktualisiert es. */
export async function registerMailbox(input: {
  address: string;
  displayName: string;
  kind: 'USER' | 'SHARED';
  authMode: 'DELEGATED' | 'APP_ONLY';
  ownerUserId?: string | null;
  graphUserId?: string | null;
  folders?: string[];
  syncEnabled?: boolean;
}): Promise<Mailbox> {
  const address = input.address.toLowerCase().trim();
  return prisma.mailbox.upsert({
    where: { address },
    create: {
      address,
      displayName: input.displayName,
      kind: input.kind,
      authMode: input.authMode,
      ownerUserId: input.ownerUserId ?? null,
      graphUserId: input.graphUserId ?? null,
      folders: input.folders ?? [],
      syncEnabled: input.syncEnabled ?? true,
    },
    update: {
      displayName: input.displayName,
      kind: input.kind,
      authMode: input.authMode,
      ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.graphUserId ? { graphUserId: input.graphUserId } : {}),
      ...(input.folders ? { folders: input.folders } : {}),
      ...(input.syncEnabled !== undefined ? { syncEnabled: input.syncEnabled } : {}),
    },
  });
}

/**
 * Verbindet die Anmeldung eines Benutzers mit seinem persönlichen Postfach.
 * Wird nach jedem Login aufgerufen: wer sich anmeldet, dessen Postfach läuft
 * ab dann delegiert – das ist datensparsamer als der App-only-Zugriff.
 */
export async function linkPersonalMailbox(
  userId: string,
  address: string,
  displayName: string,
): Promise<Mailbox> {
  return registerMailbox({
    address,
    displayName,
    kind: 'USER',
    authMode: 'DELEGATED',
    ownerUserId: userId,
  });
}

/** Der Handelnde für ein Postfach – delegiert oder App-only. */
export async function actorForMailbox(mailbox: Mailbox): Promise<GraphActor> {
  if (mailbox.authMode === 'DELEGATED') {
    if (!mailbox.ownerUserId) {
      throw new Error(
        `Postfach ${mailbox.address} ist auf delegierten Zugriff gestellt, hat aber keinen Inhaber`,
      );
    }
    // Delegiert greift der Inhaber auf sein eigenes Postfach zu: /me genügt.
    return { userId: mailbox.ownerUserId };
  }
  return { appOnly: true, mailbox: mailbox.address };
}

/** Alle Postfächer, die im nächsten Lauf synchronisiert werden. */
export async function activeMailboxes(): Promise<Mailbox[]> {
  return prisma.mailbox.findMany({
    where: {
      syncEnabled: true,
      OR: [
        { authMode: 'DELEGATED', ownerUserId: { not: null } },
        ...(isAppOnlyEnabled() ? [{ authMode: 'APP_ONLY' as const }] : []),
      ],
    },
    orderBy: { address: 'asc' },
  });
}

/** Ordner, die für ein Postfach synchronisiert werden. */
export function foldersFor(mailbox: Mailbox): string[] {
  return mailbox.folders.length > 0 ? mailbox.folders : [...config.importMailFolders];
}

/**
 * Übernimmt neu gefundene Postfächer in die Registry.
 * Neue Postfächer werden bewusst deaktiviert angelegt: erst wenn ein Mensch
 * im Dashboard entscheidet, welcher Kollege dafür zuständig ist, läuft der Sync los.
 */
export async function syncMailboxRegistry(): Promise<{ discovered: number; added: number }> {
  const discovered = await discoverMailboxes();
  let added = 0;

  for (const item of discovered) {
    const existing = await prisma.mailbox.findUnique({ where: { address: item.address } });
    if (existing) continue;

    const readable = await canReadMailbox(item.address).catch(() => false);
    if (!readable) {
      logger.debug({ address: item.address }, 'Postfach durch Zugriffsrichtlinie ausgeschlossen');
      continue;
    }

    await prisma.mailbox.create({
      data: {
        address: item.address,
        displayName: item.displayName,
        kind: item.kind,
        authMode: 'APP_ONLY',
        graphUserId: item.graphUserId,
        syncEnabled: false,
      },
    });
    added++;
  }

  logger.info({ discovered: discovered.length, added }, 'Postfach-Registry abgeglichen');
  return { discovered: discovered.length, added };
}
