/**
 * Schmaler Fetch-Wrapper.
 *
 * Bewusst ohne Client-Bibliothek: die API ist klein, und ein 401 muss überall
 * gleich behandelt werden – nämlich mit einer Weiterleitung zur Anmeldung.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    ...init,
  });

  if (response.status === 401) {
    // Sitzung abgelaufen: zurück zur Anmeldung, ohne den Fehler durchzureichen.
    if (!window.location.pathname.startsWith('/login') && !window.location.pathname.startsWith('/b/')) {
      window.location.href = '/login';
    }
    throw new ApiError(401, 'not_authenticated', 'Bitte erneut anmelden');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const error = data as { error?: string; message?: string } | null;
    throw new ApiError(
      response.status,
      error?.error ?? 'request_failed',
      error?.message ?? `Anfrage fehlgeschlagen (${response.status})`,
    );
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** Lädt eine Datei herunter, ohne die Seite zu verlassen. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) throw new ApiError(response.status, 'download_failed', 'Der Download ist fehlgeschlagen');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
