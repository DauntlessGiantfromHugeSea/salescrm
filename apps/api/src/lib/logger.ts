import { pino, type TransportSingleOptions } from 'pino';
import { createRequire } from 'node:module';
import { config } from '../config.js';

/**
 * Lesbare Ausgabe im Terminal, JSON im Betrieb.
 *
 * Die Entscheidung darf nicht allein an NODE_ENV hängen: pino-pretty ist eine
 * Entwicklungsabhängigkeit und im Produktionsabbild nicht installiert. Läuft
 * der Container mit NODE_ENV=development – etwa im Demo-Modus –, würde pino
 * beim Start abbrechen, weil es das Modul nicht auflösen kann. Deshalb wird
 * zusätzlich geprüft, ob es tatsächlich vorhanden ist.
 */
function prettyTransport(): TransportSingleOptions | undefined {
  if (config.isProduction) return undefined;
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } };
  } catch {
    // Nicht installiert: JSON-Ausgabe ist immer noch brauchbar.
    return undefined;
  }
}

export const logger = pino({
  level: config.LOG_LEVEL,
  /** Zugangsdaten dürfen niemals im Log landen. */
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'access_token',
      'refresh_token',
      '*.refreshTokenCipher',
      'MS_CLIENT_SECRET',
      'ANTHROPIC_API_KEY',
    ],
    censor: '[redacted]',
  },
  transport: prettyTransport(),
});
