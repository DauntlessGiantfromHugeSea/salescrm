import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { config } from '../config.js';

const KEY = Buffer.from(config.ENCRYPTION_KEY, 'hex');
const IV_LENGTH = 12;

/**
 * AES-256-GCM. Refresh-Tokens dürfen nie im Klartext in der Datenbank stehen –
 * ein Datenbank-Dump allein darf keinen Postfachzugriff ermöglichen.
 * Format: base64(iv) . base64(authTag) . base64(ciphertext)
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decrypt(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Chiffrat hat ein unerwartetes Format');
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

/** Signiert einen Wert für Cookies. Format: value.signature */
export function sign(value: string): string {
  const sig = createHmac('sha256', config.SESSION_SECRET).update(value).digest('base64url');
  return `${value}.${sig}`;
}

export function unsign(signed: string): string | null {
  const idx = signed.lastIndexOf('.');
  if (idx <= 0) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = createHmac('sha256', config.SESSION_SECRET).update(value).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return value;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
