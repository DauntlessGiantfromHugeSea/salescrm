import { ConfidentialClientApplication, type Configuration, LogLevel } from '@azure/msal-node';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const msalConfig: Configuration = {
  auth: {
    clientId: config.MS_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${config.MS_TENANT_ID}`,
    clientSecret: config.MS_CLIENT_SECRET,
  },
  system: {
    loggerOptions: {
      loggerCallback(level, message, containsPii) {
        if (containsPii) return;
        if (level === LogLevel.Error) logger.error({ msal: message });
        else if (level === LogLevel.Warning) logger.warn({ msal: message });
      },
      piiLoggingEnabled: false,
      logLevel: config.isProduction ? LogLevel.Warning : LogLevel.Info,
    },
  },
};

/**
 * MSAL hält intern einen Token-Cache. Wir verlassen uns bewusst nicht darauf,
 * sondern speichern den Refresh-Token selbst verschlüsselt in der Datenbank –
 * so überlebt eine Anmeldung auch Neustarts und mehrere Prozesse (API + Worker).
 *
 * Im Demo-Modus gibt es keine Zugangsdaten; der Client wird dann gar nicht
 * erst gebaut, weil MSAL sonst schon beim Import wirft.
 */
export class MicrosoftNotConfiguredError extends Error {
  constructor() {
    super(
      'Microsoft 365 ist nicht eingerichtet. Diese Funktion braucht einen Mandanten – ' +
        'siehe docs/AZURE_SETUP.md.',
    );
    this.name = 'MicrosoftNotConfiguredError';
  }
}

const client = config.hasMicrosoft ? new ConfidentialClientApplication(msalConfig) : null;

export function requireMsalClient(): ConfidentialClientApplication {
  if (!client) throw new MicrosoftNotConfiguredError();
  return client;
}

/**
 * Zugriff über einen Stellvertreter: jeder Aufruf prüft vorher, ob Microsoft
 * überhaupt eingerichtet ist. So bleibt der bestehende Aufrufcode unverändert
 * und scheitert im Demo-Modus mit einer verständlichen Meldung.
 */
export const msalClient = new Proxy({} as ConfidentialClientApplication, {
  get(_target, property) {
    const value = Reflect.get(requireMsalClient(), property) as unknown;
    return typeof value === 'function' ? value.bind(requireMsalClient()) : value;
  },
});
