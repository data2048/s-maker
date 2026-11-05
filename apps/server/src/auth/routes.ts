import {
  acceptInviteRequestSchema,
  changePasswordRequestSchema,
  createInviteRequestSchema,
  loginRequestSchema,
  passwordProblem,
  updateProfileRequestSchema,
  updateUserRequestSchema,
  type CreateInviteResponse,
  type InviteInfoResponse,
  type MeResponse,
} from '@s-maker/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { transaction } from '../db';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  parse,
  tooManyRequests,
  unauthorized,
} from '../http-error';
import { getDummyHash, hashPassword, verifyPassword } from './crypto';
import { currentUser, requireAdmin, requireUser } from './plugin';
import {
  audit,
  invites,
  LOCKOUT_MAX_FAILURES,
  loginFailures,
  sessions,
  toUserDto,
  users,
  type UserRow,
} from './store';

const tokenParam = z.object({ token: z.string().min(20).max(100) });
const idParam = z.object({ id: z.coerce.number().int().positive() });

// Stricter limits for endpoints that guess secrets (passwords, invite tokens).
const authRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  function startSession(request: FastifyRequest, reply: FastifyReply, user: UserRow): MeResponse {
    const { token, csrfToken } = sessions.create(db, user.id, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    app.setSessionCookie(reply, token);
    return { user: toUserDto(user), csrfToken };
  }

  // ---------- session ----------

  app.get('/api/auth/me', async (request): Promise<MeResponse> => {
    if (!request.user || !request.session) throw unauthorized();
    return { user: toUserDto(request.user), csrfToken: request.session.csrf_token };
  });

  app.post('/api/auth/login', { config: authRateLimit }, async (request, reply): Promise<MeResponse> => {
    const { username, password } = parse(loginRequestSchema, request.body);

    if (loginFailures.recentCount(db, username) >= LOCKOUT_MAX_FAILURES) {
      audit.log(db, 'login.locked', { ip: request.ip, details: { username } });
      throw tooManyRequests();
    }

    const user = users.byUsername(db, username);
    // Always run the hash so response time does not reveal whether the username exists.
    const ok = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));
    if (!user || !ok || user.active !== 1) {
      loginFailures.record(db, username, request.ip);
      audit.log(db, 'login.failed', { userId: user?.id, ip: request.ip, details: { username } });
      throw unauthorized('Invalid username or password');
    }

    loginFailures.clear(db, username);
    // An old session cookie (if any) is replaced by a brand new session id (no session fixation).
    if (request.session) sessions.deleteByHash(db, request.session.id_hash);
    audit.log(db, 'login.success', { userId: user.id, ip: request.ip });
    return startSession(request, reply, user);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.session) {
      sessions.deleteByHash(db, request.session.id_hash);
      audit.log(db, 'logout', { userId: request.user?.id, ip: request.ip });
    }
    app.clearSessionCookie(reply);
    return { ok: true };
  });

  // ---------- invites (public side) ----------

  app.get('/api/invites/:token', { config: authRateLimit }, async (request): Promise<InviteInfoResponse> => {
    const { token } = parse(tokenParam, request.params);
    const invite = invites.findPending(db, token);
    if (!invite) return { valid: false };
    return { valid: true, role: invite.role, ...(invite.username ? { username: invite.username } : {}) };
  });

  app.post(
    '/api/invites/:token/accept',
    { config: authRateLimit },
    async (request, reply): Promise<MeResponse> => {
      const { token } = parse(tokenParam, request.params);
      const body = parse(acceptInviteRequestSchema, request.body);
      const invite = invites.findPending(db, token);
      if (!invite) throw badRequest('This invite link is invalid or has expired');

      const username = invite.username ?? body.username;
      const problem = passwordProblem(body.password, username);
      if (problem) throw badRequest(problem);
      if (users.byUsername(db, username)) throw conflict('This username is taken');

      const passwordHash = await hashPassword(body.password);
      const user = transaction(db, () => {
        const created = users.create(db, {
          username,
          displayName: body.displayName,
          passwordHash,
          role: invite.role,
        });
        if (!invites.markUsed(db, invite.id, created.id)) {
          throw badRequest('This invite link is invalid or has expired');
        }
        return created;
      });
      audit.log(db, 'invite.accepted', { userId: user.id, ip: request.ip, details: { inviteId: invite.id } });
      return startSession(request, reply, user);
    },
  );

  // ---------- own profile ----------

  app.patch('/api/me', { preHandler: requireUser }, async (request) => {
    const me = currentUser(request);
    const { displayName } = parse(updateProfileRequestSchema, request.body);
    users.update(db, me.id, { displayName });
    return { user: toUserDto(users.byId(db, me.id)!) };
  });

  app.post('/api/me/password', { preHandler: requireUser, config: authRateLimit }, async (request) => {
    const me = currentUser(request);
    const { currentPassword, newPassword } = parse(changePasswordRequestSchema, request.body);
    if (!(await verifyPassword(currentPassword, me.password_hash))) {
      audit.log(db, 'password.change_failed', { userId: me.id, ip: request.ip });
      throw badRequest('Current password is wrong');
    }
    const problem = passwordProblem(newPassword, me.username);
    if (problem) throw badRequest(problem);
    users.update(db, me.id, { passwordHash: await hashPassword(newPassword) });
    // Log out every other device.
    sessions.deleteForUser(db, me.id, request.session?.id_hash);
    audit.log(db, 'password.changed', { userId: me.id, ip: request.ip });
    return { ok: true };
  });

  // ---------- admin ----------

  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => {
    return { users: users.list(db).map(toUserDto) };
  });

  app.patch('/api/admin/users/:id', { preHandler: requireAdmin }, async (request) => {
    const me = currentUser(request);
    const { id } = parse(idParam, request.params);
    const patch = parse(updateUserRequestSchema, request.body);
    const target = users.byId(db, id);
    if (!target) throw notFound('User not found');
    if (target.id === me.id) throw forbidden('You cannot change your own role or status');

    const losesAdmin =
      target.role === 'admin' && target.active === 1 && (patch.role === 'user' || patch.active === false);
    if (losesAdmin && users.activeAdminCount(db) <= 1)
      throw conflict('At least one active admin is required');

    users.update(db, id, patch);
    if (patch.active === false) sessions.deleteForUser(db, id);
    audit.log(db, 'admin.user_updated', { userId: me.id, ip: request.ip, details: { target: id, ...patch } });
    return { user: toUserDto(users.byId(db, id)!) };
  });

  app.get('/api/admin/invites', { preHandler: requireAdmin }, async () => {
    return { invites: invites.list(db) };
  });

  app.post(
    '/api/admin/invites',
    { preHandler: requireAdmin },
    async (request): Promise<CreateInviteResponse> => {
      const me = currentUser(request);
      const body = parse(createInviteRequestSchema, request.body ?? {});
      const { token, id } = invites.create(db, {
        role: body.role,
        note: body.note,
        createdBy: me.id,
        expiresInHours: body.expiresInHours,
      });
      audit.log(db, 'admin.invite_created', {
        userId: me.id,
        ip: request.ip,
        details: { inviteId: id, role: body.role },
      });
      return { invite: invites.byId(db, id)!, link: inviteLink(app.config.publicUrl, token) };
    },
  );

  app.delete('/api/admin/invites/:id', { preHandler: requireAdmin }, async (request) => {
    const me = currentUser(request);
    const { id } = parse(idParam, request.params);
    if (!invites.revoke(db, id)) throw notFound('No pending invite with this id');
    audit.log(db, 'admin.invite_revoked', { userId: me.id, ip: request.ip, details: { inviteId: id } });
    return { ok: true };
  });

  app.get('/api/admin/audit', { preHandler: requireAdmin }, async (request) => {
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      request.query,
    );
    return { entries: audit.list(db, limit) };
  });
}

export function inviteLink(publicUrl: string, token: string): string {
  return `${publicUrl}/invite/${token}`;
}
