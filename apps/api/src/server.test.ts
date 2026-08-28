import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Starttest.
 *
 * Prüft, dass sich der Server tatsächlich aufbauen lässt – nicht nur, dass die
 * Typen stimmen. Anlass waren drei Fehler hintereinander, die alle erst im
 * Betrieb auffielen und die ein Typecheck nicht sehen kann: eine Bibliothek,
 * die zur Laufzeit fehlt, und eine Option, die eine neue Hauptversion anders
 * erwartet.
 *
 * Der Test braucht weder Datenbank noch Redis: beide werden erst beim
 * tatsächlichen Zugriff kontaktiert, nicht beim Aufbau.
 */

// Muss vor dem Import der Konfiguration stehen – sie liest die Umgebung sofort.
function setDemoEnvironment(): void {
  Object.assign(process.env, {
    NODE_ENV: 'development',
    DEMO_MODE: 'true',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
    // Ein Port, auf dem nichts läuft: ioredis versucht im Hintergrund zu
    // verbinden, blockiert den Aufbau aber nicht.
    REDIS_URL: 'redis://127.0.0.1:1',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    ENCRYPTION_KEY: 'a'.repeat(64),
    SESSION_SECRET: 's'.repeat(48),
  });
}

let app: Awaited<ReturnType<typeof import('./server.js')['buildServer']>> | null = null;

before(async () => {
  setDemoEnvironment();
  const { buildServer } = await import('./server.js');
  app = await buildServer();
});

after(async () => {
  await app?.close();
  const { closeQueue } = await import('./jobs/queue.js');
  await closeQueue().catch(() => undefined);
  const { disconnectDb } = await import('./lib/db.js');
  await disconnectDb().catch(() => undefined);
});

describe('Serverstart', () => {
  test('der Server lässt sich aufbauen', () => {
    assert.ok(app, 'buildServer hat keine Instanz geliefert');
  });

  test('die Zustandsabfrage ist erreichbar und meldet den Demo-Modus', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/health/demo' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { demoMode: boolean; hasMicrosoft: boolean };
    assert.equal(body.demoMode, true);
    assert.equal(body.hasMicrosoft, false, 'ohne Zugangsdaten darf Microsoft nicht als verfügbar gelten');
  });

  test('geschützte Routen verlangen eine Anmeldung', async () => {
    for (const url of ['/api/dashboard', '/api/deals', '/api/projects', '/api/drafts']) {
      const response = await app!.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, `${url} war ohne Anmeldung erreichbar`);
    }
  });

  test('die Demo-Anmeldung ist im Demo-Modus registriert', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/auth/demo-login' });
    // Ohne Datenbank scheitert das Anlegen des Benutzers – entscheidend ist,
    // dass die Route existiert und nicht mit 404 antwortet.
    assert.notEqual(response.statusCode, 404, 'Die Demo-Anmeldung fehlt');
  });

  test('die öffentliche Buchungsseite verlangt keine Anmeldung', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/public/booking/gibt-es-nicht' });
    assert.notEqual(response.statusCode, 401, 'Die Buchungsseite darf keine Anmeldung verlangen');
  });
});
