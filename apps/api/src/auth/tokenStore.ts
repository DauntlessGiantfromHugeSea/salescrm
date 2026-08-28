import type { MsAccount } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { msalClient } from './msal.js';
import { GRAPH_SCOPES } from './scopes.js';

/** Nur die Berechtigungen, die im Token angefordert werden (ohne OIDC-Standardscopes). */
const RESOURCE_SCOPES = GRAPH_SCOPES.filter(
  (s) => !['openid', 'profile', 'email', 'offline_access'].includes(s),
).map((s) => `https://graph.microsoft.com/${s}`);

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Prozesslokaler Cache. Access-Tokens leben eine Stunde; ohne Cache würde jeder
 * Graph-Aufruf einen Token-Endpoint-Roundtrip auslösen und in Rate-Limits laufen.
 */
const cache = new Map<string, CachedToken>();

/** 5 Minuten Sicherheitsabstand, damit ein Token nicht mitten im Request abläuft. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export class MailboxNotConnectedError extends Error {
  constructor(readonly userId: string) {
    super(`Für Benutzer ${userId} ist kein Microsoft-Konto verbunden`);
    this.name = 'MailboxNotConnectedError';
  }
}

export class TokenExpiredError extends Error {
  constructor(readonly userId: string, cause?: unknown) {
    super(`Die Microsoft-Anmeldung für Benutzer ${userId} ist abgelaufen – erneute Anmeldung nötig`);
    this.name = 'TokenExpiredError';
    this.cause = cause;
  }
}

/**
 * Legt die Tokens einer frischen Anmeldung ab. Der Refresh-Token wird aus dem
 * MSAL-Cache gezogen, weil die Bibliothek ihn nicht direkt im Ergebnis zurückgibt.
 */
export async function persistTokens(params: {
  userId: string;
  tenantId: string;
  homeAccountId: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: Date | null;
  mailboxAddress: string | null;
}): Promise<void> {
  const data = {
    tenantId: params.tenantId,
    homeAccountId: params.homeAccountId,
    refreshTokenCipher: encrypt(params.refreshToken),
    scopes: params.scopes,
    accessTokenExpiresAt: params.expiresAt,
    mailboxAddress: params.mailboxAddress,
    lastRefreshAt: new Date(),
    lastError: null,
  };
  await prisma.msAccount.upsert({
    where: { userId: params.userId },
    create: { userId: params.userId, connectedAt: new Date(), ...data },
    update: data,
  });
  cache.delete(params.userId);
}

/**
 * Liefert einen gültigen Access-Token für Graph.
 * Reihenfolge: Prozesscache → Refresh-Token-Tausch → Fehler mit klarer Ursache.
 */
export async function getAccessToken(userId: string): Promise<string> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return cached.accessToken;
  }

  const account = await prisma.msAccount.findUnique({ where: { userId } });
  if (!account) throw new MailboxNotConnectedError(userId);

  return refreshAccessToken(account);
}

async function refreshAccessToken(account: MsAccount): Promise<string> {
  let refreshToken: string;
  try {
    refreshToken = decrypt(account.refreshTokenCipher);
  } catch (err) {
    logger.error({ err, userId: account.userId }, 'Refresh-Token nicht entschlüsselbar');
    throw new TokenExpiredError(account.userId, err);
  }

  try {
    const result = await msalClient.acquireTokenByRefreshToken({
      refreshToken,
      scopes: RESOURCE_SCOPES,
      forceCache: true,
    });
    if (!result?.accessToken) throw new Error('Antwort ohne Access-Token');

    const expiresAt = result.expiresOn?.getTime() ?? Date.now() + 3600_000;
    cache.set(account.userId, { accessToken: result.accessToken, expiresAt });

    // Microsoft rotiert Refresh-Tokens. Den neuen holen wir aus dem MSAL-Cache
    // und schreiben ihn zurück, sonst läuft die Anmeldung nach ~90 Tagen ins Leere.
    const rotated = await extractRefreshToken(account.homeAccountId);
    await prisma.msAccount.update({
      where: { userId: account.userId },
      data: {
        accessTokenExpiresAt: new Date(expiresAt),
        lastRefreshAt: new Date(),
        lastError: null,
        ...(rotated && rotated !== refreshToken ? { refreshTokenCipher: encrypt(rotated) } : {}),
      },
    });

    return result.accessToken;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.msAccount.update({
      where: { userId: account.userId },
      data: { lastError: message.slice(0, 500) },
    });
    logger.error({ err, userId: account.userId }, 'Token-Refresh fehlgeschlagen');
    throw new TokenExpiredError(account.userId, err);
  }
}

/**
 * Zieht den aktuellen Refresh-Token aus dem internen MSAL-Cache.
 * Es gibt dafür keine öffentliche API; der Zugriff ist bewusst defensiv
 * formuliert und darf im Fehlerfall einfach nichts liefern.
 */
export async function extractRefreshToken(homeAccountId?: string): Promise<string | null> {
  try {
    const cacheJson = JSON.parse(msalClient.getTokenCache().serialize()) as {
      RefreshToken?: Record<string, { secret?: string; home_account_id?: string }>;
    };
    const entries = Object.values(cacheJson.RefreshToken ?? {});
    if (entries.length === 0) return null;
    const match = homeAccountId
      ? entries.find((e) => e.home_account_id === homeAccountId)
      : entries[0];
    return (match ?? entries[0])?.secret ?? null;
  } catch (err) {
    logger.warn({ err }, 'Refresh-Token konnte nicht aus dem MSAL-Cache gelesen werden');
    return null;
  }
}

export async function disconnectMailbox(userId: string): Promise<void> {
  cache.delete(userId);
  await prisma.msAccount.deleteMany({ where: { userId } });
}

export function grantedScopes(account: Pick<MsAccount, 'scopes'>): Set<string> {
  return new Set(account.scopes.map((s) => s.split('/').pop() ?? s));
}
