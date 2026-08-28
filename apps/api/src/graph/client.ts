import { getAccessToken } from '../auth/tokenStore.js';
import { getAppAccessToken } from '../auth/appToken.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_BETA = 'https://graph.microsoft.com/beta';

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }

  /** true, wenn die Berechtigung fehlt – die Funktion wird dann im Dashboard ausgegraut. */
  get isPermissionDenied(): boolean {
    return this.status === 403 || this.code === 'Authorization_RequestDenied';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/**
 * Wer den Aufruf ausführt.
 *
 * `{ userId }`  – im Namen einer Person (persönliches Postfach, Mailversand,
 *                 Teams-Termine: alles, was der Benutzer selbst tut).
 * `{ appOnly }` – mit der Anwendungsidentität (gemeinsame Firmenpostfächer).
 *
 * Bei App-only muss der Pfad das Postfach benennen (`/users/{adresse}/…`),
 * weil es kein „ich" gibt. `resolvePath` erledigt das.
 */
export type GraphActor = { userId: string; mailbox?: string } | { appOnly: true; mailbox: string };

export function isAppOnly(actor: GraphActor): actor is { appOnly: true; mailbox: string } {
  return 'appOnly' in actor;
}

async function tokenFor(actor: GraphActor): Promise<string> {
  if (!config.hasMicrosoft) {
    throw new GraphError(
      503,
      'microsoft_not_configured',
      'Microsoft 365 ist nicht eingerichtet. Postfach, Kalender und Teams stehen ' +
        'erst nach der Einrichtung zur Verfügung (docs/AZURE_SETUP.md).',
    );
  }
  return isAppOnly(actor) ? getAppAccessToken() : getAccessToken(actor.userId);
}

/**
 * Übersetzt einen `/me/…`-Pfad in die Postfach-Adressierung.
 * Delegierte Aufrufe auf das eigene Postfach bleiben unverändert.
 */
export function resolvePath(actor: GraphActor, path: string): string {
  if (!path.startsWith('/me/') && path !== '/me') return path;
  const mailbox = actor.mailbox;
  if (!mailbox) {
    if (isAppOnly(actor)) {
      throw new GraphError(400, 'no_mailbox', 'App-only-Aufrufe brauchen ein Zielpostfach');
    }
    return path;
  }
  return `/users/${encodeURIComponent(mailbox)}${path.slice(3)}`;
}

interface GraphRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Vollständige URL statt Pfad – für @odata.nextLink und deltaLink. */
  absoluteUrl?: string;
  beta?: boolean;
  headers?: Record<string, string>;
  /** Bei 404 null zurückgeben statt zu werfen. */
  tolerateNotFound?: boolean;
}

const MAX_ATTEMPTS = 5;

/**
 * Ein Graph-Aufruf mit der Behandlung, die Microsoft in der Praxis erzwingt:
 * 429 und 503 kommen bei größeren Postfächern regelmäßig vor, das Retry-After
 * ist verbindlich. Ohne diese Schleife bricht der Erstimport reproduzierbar ab.
 */
export async function graphRequest<T>(
  actor: GraphActor | string,
  path: string,
  options: GraphRequestOptions = {},
): Promise<T> {
  const resolved: GraphActor = typeof actor === 'string' ? { userId: actor } : actor;
  const { method = 'GET', body, absoluteUrl, beta = false, headers = {} } = options;
  const url = absoluteUrl ?? `${beta ? GRAPH_BETA : GRAPH_BASE}${resolvePath(resolved, path)}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const token = await tokenFor(resolved);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 204) return undefined as T;

    if (response.ok) {
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }

    if (response.status === 404 && options.tolerateNotFound) {
      return null as T;
    }

    // Throttling und transiente Serverfehler: warten und erneut versuchen.
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2 ** attempt * 500, 30_000);
      logger.warn(
        { url, status: response.status, attempt, waitMs },
        'Graph drosselt oder ist kurzzeitig gestört – erneuter Versuch',
      );
      lastError = new GraphError(response.status, 'throttled', `HTTP ${response.status}`);
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(waitMs);
      continue;
    }

    const errorBody = (await safeJson(response)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new GraphError(
      response.status,
      errorBody?.error?.code ?? 'unknown',
      errorBody?.error?.message ?? `Graph-Aufruf fehlgeschlagen (HTTP ${response.status})`,
      response.headers.get('request-id') ?? undefined,
    );
  }

  throw lastError instanceof Error
    ? lastError
    : new GraphError(500, 'exhausted', 'Graph-Aufruf nach mehreren Versuchen aufgegeben');
}

/**
 * Läuft eine ausgelagerte Ergebnisliste vollständig ab.
 * `maxItems` begrenzt den Speicherbedarf beim Import großer Postfächer.
 */
export async function* graphPaginate<T>(
  actor: GraphActor | string,
  path: string,
  options: { maxItems?: number; beta?: boolean } = {},
): AsyncGenerator<T, void, undefined> {
  const { maxItems = Number.POSITIVE_INFINITY, beta = false } = options;
  let next: string | undefined;
  let count = 0;

  while (count < maxItems) {
    const page: { value?: T[]; '@odata.nextLink'?: string } = await graphRequest(actor, path, {
      absoluteUrl: next,
      beta,
    });
    for (const item of page.value ?? []) {
      yield item;
      if (++count >= maxItems) return;
    }
    if (!page['@odata.nextLink']) return;
    next = page['@odata.nextLink'];
  }
}

/**
 * Delta-Abfrage. Liefert die Änderungen seit dem letzten Lauf und den neuen
 * deltaLink, der für den nächsten Lauf gespeichert wird – das ist der Grund,
 * warum der nächtliche Sync nicht jedes Mal 150 GB anfassen muss.
 */
export async function graphDelta<T>(
  actor: GraphActor | string,
  startUrlOrPath: string,
  options: { maxItems?: number } = {},
): Promise<{ items: T[]; deltaLink: string | null }> {
  const { maxItems = 5000 } = options;
  const items: T[] = [];
  let url: string | undefined;
  let path = startUrlOrPath.startsWith('http') ? '' : startUrlOrPath;
  if (startUrlOrPath.startsWith('http')) url = startUrlOrPath;

  for (;;) {
    const page: {
      value?: T[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    } = await graphRequest(actor, path, { absoluteUrl: url });

    items.push(...(page.value ?? []));

    if (page['@odata.deltaLink']) {
      return { items, deltaLink: page['@odata.deltaLink'] };
    }
    if (!page['@odata.nextLink'] || items.length >= maxItems) {
      // Abbruch wegen Obergrenze: kein deltaLink, der nächste Lauf setzt neu an.
      return { items, deltaLink: page['@odata.nextLink'] ?? null };
    }
    url = page['@odata.nextLink'];
    path = '';
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
