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
 */
export const msalClient = new ConfidentialClientApplication(msalConfig);
