import { pino } from 'pino';
import { config } from '../config.js';

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
  transport: config.isProduction ? undefined : { target: 'pino-pretty', options: { colorize: true } },
});
