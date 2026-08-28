import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../lib/db.js';
import { sign, unsign } from '../lib/crypto.js';

export const SESSION_COOKIE = 'scrm_session';
const SESSION_MAX_AGE_S = 60 * 60 * 12;

export interface SessionPayload {
  userId: string;
  issuedAt: number;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  timezone: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: AuthenticatedUser;
  }
}

export function setSessionCookie(reply: FastifyReply, userId: string): void {
  const payload: SessionPayload = { userId, issuedAt: Date.now() };
  const value = sign(Buffer.from(JSON.stringify(payload)).toString('base64url'));
  reply.setCookie(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

function readSession(request: FastifyRequest): SessionPayload | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = unsign(raw);
  if (!unsigned) return null;
  try {
    const payload = JSON.parse(Buffer.from(unsigned, 'base64url').toString('utf8')) as SessionPayload;
    if (Date.now() - payload.issuedAt > SESSION_MAX_AGE_S * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Lädt den angemeldeten Benutzer. Wird als preHandler auf alle geschützten
 * Routen gehängt; öffentliche Routen (Buchungsseite, Health) binden sie nicht ein.
 */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = readSession(request);
  if (!session) {
    await reply.status(401).send({ error: 'not_authenticated' });
    return;
  }
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, displayName: true, role: true, timezone: true, active: true },
  });
  if (!user || !user.active) {
    clearSessionCookie(reply);
    await reply.status(401).send({ error: 'not_authenticated' });
    return;
  }
  request.currentUser = user;
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireUser(request, reply);
  if (reply.sent) return;
  if (request.currentUser?.role !== 'ADMIN') {
    await reply.status(403).send({ error: 'forbidden' });
  }
}

export function currentUser(request: FastifyRequest): AuthenticatedUser {
  const user = request.currentUser;
  if (!user) throw new Error('requireUser wurde für diese Route nicht registriert');
  return user;
}

/**
 * Sichtbarkeitsfilter für Prisma-Abfragen (Kapitel 5).
 * ADMIN sieht alles, USER nur die eigenen Datensätze – ohne dass jede
 * einzelne Route daran denken muss.
 */
export function ownerScope(user: AuthenticatedUser): { ownerId?: string } {
  return user.role === 'ADMIN' ? {} : { ownerId: user.id };
}
