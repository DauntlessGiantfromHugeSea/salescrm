import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { randomToken, sign, unsign } from '../lib/crypto.js';
import { msalClient } from '../auth/msal.js';
import { GRAPH_SCOPES, OPTIONAL_SCOPES, REQUIRED_SCOPES } from '../auth/scopes.js';
import { extractRefreshToken, persistTokens, disconnectMailbox } from '../auth/tokenStore.js';
import {
  clearSessionCookie,
  currentUser,
  requireUser,
  setSessionCookie,
} from '../auth/session.js';
import { graphRequest } from '../graph/client.js';
import type { GraphUser } from '../graph/types.js';
import { audit } from '../lib/audit.js';
import { linkPersonalMailbox } from '../graph/mailboxRegistry.js';
import { enqueueUserSync, enqueueMailboxSync } from '../jobs/queue.js';

const STATE_COOKIE = 'scrm_oauth_state';
const VERIFIER_COOKIE = 'scrm_oauth_verifier';

/**
 * Anmeldung über Microsoft. Es gibt bewusst kein eigenes Passwort:
 * wer keinen Zugriff mehr auf das Firmenkonto hat, hat auch keinen
 * Zugriff mehr auf das Akquisesystem.
 *
 * Alle Weiterleitungen innerhalb der Anwendung sind bewusst relativ. Absolute
 * Ziele auf PUBLIC_BASE_URL würden den Browser auf einen anderen Host schicken,
 * sobald der Zugriff nicht über genau diese Adresse läuft – etwa über einen
 * SSH-Tunnel auf localhost. Das Session-Cookie gilt dann für den anderen Host
 * und geht verloren: man landet nach erfolgreicher Anmeldung wieder auf der
 * Anmeldeseite. PUBLIC_BASE_URL bleibt für das, was tatsächlich absolut sein
 * muss: die Umleitungs-URI zu Microsoft und die Buchungslinks.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Anmeldung ohne Microsoft – ausschließlich zum Ausprobieren.
   *
   * Die Route wird nur registriert, wenn DEMO_MODE gesetzt ist, und die
   * Konfiguration verweigert den Start, wenn das mit NODE_ENV=production
   * zusammenfällt. Zwei Sperren, weil eine offene Anmeldung in einem
   * erreichbaren System der schlimmste denkbare Fehler wäre.
   */
  if (config.DEMO_MODE) {
    app.get('/api/auth/demo-login', async (request, reply) => {
      const email = config.DEMO_USER_EMAIL.toLowerCase();
      const user = await prisma.user.upsert({
        where: { email },
        create: { email, displayName: 'Demo-Benutzer', role: 'ADMIN' },
        update: { active: true, role: 'ADMIN' },
      });
      logger.warn({ email }, 'Demo-Anmeldung ohne Microsoft – nur für Testzwecke');
      setSessionCookie(reply, user.id);
      return reply.redirect('/');
    });
  }

  app.get('/api/auth/login', async (request, reply) => {
    // Im Demo-Modus gibt es keinen Microsoft-Mandanten, an den weitergeleitet
    // werden könnte – die Anmeldeseite bietet stattdessen den Demo-Login an.
    if (!config.hasMicrosoft) {
      return reply.redirect(`/login?error=no_microsoft`);
    }

    const state = randomToken(16);
    const { verifier, challenge } = await generatePkce();

    const cookieOptions = {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 600,
    };
    reply.setCookie(STATE_COOKIE, sign(state), cookieOptions);
    reply.setCookie(VERIFIER_COOKIE, sign(verifier), cookieOptions);

    const url = await msalClient.getAuthCodeUrl({
      scopes: [...GRAPH_SCOPES],
      redirectUri: config.MS_REDIRECT_URI,
      state,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      prompt: (request.query as { prompt?: string }).prompt === 'consent' ? 'consent' : undefined,
    });

    return reply.redirect(url);
  });

  app.get('/api/auth/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };

    if (query.error) {
      logger.warn({ error: query.error, description: query.error_description }, 'Anmeldung abgebrochen');
      return reply.redirect(`/login?error=${encodeURIComponent(query.error)}`);
    }
    if (!query.code || !query.state) {
      return reply.redirect(`/login?error=missing_code`);
    }

    const expectedState = unsignCookie(request.cookies[STATE_COOKIE]);
    const verifier = unsignCookie(request.cookies[VERIFIER_COOKIE]);
    reply.clearCookie(STATE_COOKIE, { path: '/' });
    reply.clearCookie(VERIFIER_COOKIE, { path: '/' });

    if (!expectedState || expectedState !== query.state || !verifier) {
      logger.warn('State- oder Verifier-Prüfung fehlgeschlagen – möglicher CSRF-Versuch');
      return reply.redirect(`/login?error=state_mismatch`);
    }

    let result;
    try {
      result = await msalClient.acquireTokenByCode({
        code: query.code,
        scopes: [...GRAPH_SCOPES],
        redirectUri: config.MS_REDIRECT_URI,
        codeVerifier: verifier,
      });
    } catch (err) {
      logger.error({ err }, 'Token-Austausch fehlgeschlagen');
      return reply.redirect(`/login?error=token_exchange`);
    }

    const account = result.account;
    const email = (account?.username ?? '').toLowerCase();
    if (!email) {
      return reply.redirect(`/login?error=no_account`);
    }

    // Zugangskontrolle: nur freigegebene Adressen dürfen ins Dashboard.
    if (config.allowedLoginEmails.length > 0 && !config.allowedLoginEmails.includes(email)) {
      logger.warn({ email }, 'Anmeldung durch nicht freigegebene Adresse abgewiesen');
      return reply.redirect(`/login?error=not_allowed`);
    }

    const grantedScopes = result.scopes ?? [];
    const missing = REQUIRED_SCOPES.filter(
      (s) => !grantedScopes.some((g) => g.toLowerCase().endsWith(s.toLowerCase())),
    );
    if (missing.length > 0) {
      logger.warn({ email, missing }, 'Pflichtberechtigungen fehlen');
      return reply.redirect(
        `/login?error=missing_scopes&detail=${encodeURIComponent(missing.join(','))}`,
      );
    }

    // Profil aus Graph nachladen, damit Anzeigename und Zeitzone stimmen.
    let profile: GraphUser | null = null;
    const userCount = await prisma.user.count();
    const isBootstrapAdmin =
      config.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase() === email || userCount === 0;

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        displayName: account?.name ?? email,
        msObjectId: account?.homeAccountId?.split('.')[0] ?? null,
        role: isBootstrapAdmin ? 'ADMIN' : 'USER',
      },
      update: {
        displayName: account?.name ?? undefined,
        active: true,
        ...(isBootstrapAdmin ? { role: 'ADMIN' as const } : {}),
      },
    });

    const refreshToken = await extractRefreshToken(account?.homeAccountId);
    if (!refreshToken) {
      logger.error({ email }, 'Kein Refresh-Token erhalten – offline_access im Tenant blockiert?');
      return reply.redirect(`/login?error=no_refresh_token`);
    }

    await persistTokens({
      userId: user.id,
      tenantId: account?.tenantId ?? config.MS_TENANT_ID,
      homeAccountId: account?.homeAccountId ?? '',
      refreshToken,
      scopes: grantedScopes,
      expiresAt: result.expiresOn ?? null,
      mailboxAddress: email,
    });

    try {
      profile = await graphRequest<GraphUser>(user.id, '/me?$select=id,displayName,mail,userPrincipalName');
      if (profile?.displayName && profile.displayName !== user.displayName) {
        await prisma.user.update({ where: { id: user.id }, data: { displayName: profile.displayName } });
      }
    } catch (err) {
      logger.warn({ err }, 'Profilabruf nach Anmeldung fehlgeschlagen – nicht kritisch');
    }

    // Wer sich anmeldet, dessen persönliches Postfach läuft ab jetzt delegiert –
    // das ist datensparsamer als der Zugriff mit der Anwendungsidentität.
    try {
      const mailbox = await linkPersonalMailbox(user.id, email, profile?.displayName ?? user.displayName);
      await enqueueMailboxSync(mailbox.id);
      await enqueueUserSync(user.id);
    } catch (err) {
      logger.warn({ err, userId: user.id }, 'Erstsynchronisation konnte nicht angestoßen werden');
    }

    await audit({ userId: user.id, action: 'auth.login', entityType: 'User', entityId: user.id, ip: request.ip });

    setSessionCookie(reply, user.id);
    return reply.redirect('/');
  });

  app.post('/api/auth/logout', async (request, reply) => {
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const account = await prisma.msAccount.findUnique({ where: { userId: user.id } });

    const granted = new Set((account?.scopes ?? []).map((s) => s.split('/').pop() ?? s));
    const unavailableFeatures = Object.entries(OPTIONAL_SCOPES)
      .filter(([scope]) => !granted.has(scope))
      .map(([scope, feature]) => ({ scope, feature }));

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      timezone: user.timezone,
      demoMode: config.DEMO_MODE,
      hasMicrosoft: config.hasMicrosoft,
      hasAi: config.hasAi,
      hasMailboxConnected: Boolean(account),
      mailboxAddress: account?.mailboxAddress ?? null,
      connectionError: account?.lastError ?? null,
      unavailableFeatures,
    };
  });

  /** Verbindung lösen – Tokens werden gelöscht, Stammdaten bleiben erhalten. */
  app.post('/api/auth/disconnect', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    await disconnectMailbox(user.id);
    await audit({ userId: user.id, action: 'auth.mailbox_disconnected', entityType: 'MsAccount', ip: request.ip });
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });
}

function unsignCookie(raw: string | undefined): string | null {
  return raw ? unsign(raw) : null;
}

/** PKCE nach RFC 7636 – schützt den Autorisierungscode auch ohne Client-Secret im Browser. */
async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const { createHash } = await import('node:crypto');
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
