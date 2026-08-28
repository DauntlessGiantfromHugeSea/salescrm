import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Anwendungsidentität für den firmenweiten Postfachzugriff (Client Credentials).
 *
 * Anders als beim delegierten Zugriff handelt die App hier nicht im Namen einer
 * Person, sondern mit eigener Berechtigung. Damit sie nicht jedes Postfach des
 * Tenants lesen kann, muss im Exchange eine ApplicationAccessPolicy die Reichweite
 * auf eine Sicherheitsgruppe begrenzen – ohne diese Policy hätte die App Zugriff
 * auf sämtliche Postfächer der Organisation. Siehe docs/AZURE_SETUP.md.
 */

const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${config.MS_TENANT_ID}/oauth2/v2.0/token`;
const SCOPE = 'https://graph.microsoft.com/.default';
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

let cached: { token: string; expiresAt: number } | null = null;

export class AppOnlyNotConfiguredError extends Error {
  constructor() {
    super(
      'Firmenweiter Postfachzugriff ist nicht eingerichtet. ' +
        'MS_APP_ONLY_ENABLED=true setzen und die Anwendungsberechtigungen im Tenant freigeben.',
    );
    this.name = 'AppOnlyNotConfiguredError';
  }
}

export function isAppOnlyEnabled(): boolean {
  return config.MS_APP_ONLY_ENABLED;
}

/**
 * Liefert einen Anwendungs-Token. Der Token gilt tenantweit und wird
 * prozesslokal zwischengespeichert – er hängt an keinem Benutzer.
 */
export async function getAppAccessToken(): Promise<string> {
  if (!config.MS_APP_ONLY_ENABLED) throw new AppOnlyNotConfiguredError();

  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return cached.token;
  }

  const body = new URLSearchParams({
    client_id: config.MS_CLIENT_ID,
    client_secret: config.MS_CLIENT_SECRET,
    scope: SCOPE,
    grant_type: 'client_credentials',
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    logger.error({ status: response.status, detail: detail.slice(0, 500) }, 'Anwendungs-Token nicht erhalten');
    throw new Error(`Anwendungs-Token konnte nicht geholt werden (HTTP ${response.status})`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  cached = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

export function clearAppTokenCache(): void {
  cached = null;
}
