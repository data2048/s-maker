import fastifyCookie from '@fastify/cookie';
import { CSRF_HEADER } from '@s-maker/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { forbidden, unauthorized } from '../http-error';
import { safeEqual } from './crypto';
import { SESSION_ABSOLUTE_MS, sessions, type SessionRow, type UserRow } from './store';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    session: SessionRow | null;
  }
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function sessionCookieName(secure: boolean): string {
  // The __Host- prefix makes browsers refuse the cookie unless it is Secure, host-only and Path=/.
  return secure ? '__Host-smaker_sid' : 'smaker_sid';
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  const { config, db } = app;
  const cookieName = sessionCookieName(config.secureCookies);
  const allowedOrigin = new URL(config.publicUrl).origin;

  await app.register(fastifyCookie);

  app.decorateRequest('user', null);
  app.decorateRequest('session', null);

  app.decorate('setSessionCookie', (reply: FastifyReply, token: string) => {
    reply.setCookie(cookieName, token, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
    });
  });
  app.decorate('clearSessionCookie', (reply: FastifyReply) => {
    reply.clearCookie(cookieName, { path: '/', secure: config.secureCookies, sameSite: 'lax' });
  });

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/') && !request.url.startsWith('/ws')) return;

    // CSRF layer 1: state-changing requests must come from our own origin.
    if (STATE_CHANGING.has(request.method)) {
      const origin = request.headers.origin;
      if (!origin || origin !== allowedOrigin) {
        throw forbidden('Cross-origin request blocked');
      }
    }

    const token = request.cookies[cookieName];
    if (token) {
      const resolved = sessions.resolve(db, token);
      if (resolved) {
        request.user = resolved.user;
        request.session = resolved.session;
      }
    }

    // CSRF layer 2: logged-in requests that change state must carry the session's CSRF token.
    if (STATE_CHANGING.has(request.method) && request.session) {
      const sent = request.headers[CSRF_HEADER];
      if (typeof sent !== 'string' || !safeEqual(sent, request.session.csrf_token)) {
        throw forbidden('Missing or invalid CSRF token');
      }
    }
  });
}

export default fp(authPlugin, { name: 'auth' });

declare module 'fastify' {
  interface FastifyInstance {
    setSessionCookie(reply: FastifyReply, token: string): void;
    clearSessionCookie(reply: FastifyReply): void;
  }
}

/** preHandler: the request must belong to a logged-in, active user. */
export async function requireUser(request: FastifyRequest): Promise<void> {
  if (!request.user) throw unauthorized();
}

/** preHandler: the request must belong to an admin. */
export async function requireAdmin(request: FastifyRequest): Promise<void> {
  if (!request.user) throw unauthorized();
  if (request.user.role !== 'admin') throw forbidden();
}

/** Narrowing helper for handlers behind requireUser. */
export function currentUser(request: FastifyRequest): UserRow {
  if (!request.user) throw unauthorized();
  return request.user;
}
