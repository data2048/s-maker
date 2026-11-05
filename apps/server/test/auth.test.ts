import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../src/auth/bootstrap';
import { hashPassword, verifyPassword } from '../src/auth/crypto';
import type { Db } from '../src/db';
import {
  acceptInvite,
  call,
  createTestApp,
  createUser,
  ORIGIN,
  PASSWORD,
  setupAdmin,
  silentLog,
  tokenFromLink,
  type Client,
} from './helpers';

let app: FastifyInstance;
let db: Db;

beforeEach(async () => {
  ({ app, db } = await createTestApp());
});
afterEach(async () => {
  await app.close();
});

const login = (username: string, password: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN },
    payload: { username, password },
  });

describe('password hashing', () => {
  it('hashes with argon2id and verifies', async () => {
    const hash = await hashPassword('some long password');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword('some long password', hash)).toBe(true);
    expect(await verifyPassword('wrong password!!', hash)).toBe(false);
    expect(await verifyPassword('x', 'not a hash')).toBe(false);
  });
});

describe('bootstrap', () => {
  it('creates a one-time admin link only while there are no users', async () => {
    const link = bootstrapAdmin(db, app.config, silentLog)!;
    expect(link).toMatch(/^http:\/\/localhost:44566\/invite\/[\w-]{40,}$/);

    const info = await app.inject({ method: 'GET', url: `/api/invites/${tokenFromLink(link)}` });
    expect(info.json()).toEqual({ valid: true, role: 'admin', username: 'admin' });

    // The fixed username wins over what the form sends.
    const res = await acceptInvite(app, tokenFromLink(link), { username: 'someone-else' });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ username: 'admin', role: 'admin' });

    expect(bootstrapAdmin(db, app.config, silentLog)).toBeNull();
  });

  it('a restart replaces the previous link', async () => {
    const first = bootstrapAdmin(db, app.config, silentLog)!;
    const second = bootstrapAdmin(db, app.config, silentLog)!;
    expect((await acceptInvite(app, tokenFromLink(first), { username: 'admin' })).statusCode).toBe(400);
    expect((await acceptInvite(app, tokenFromLink(second), { username: 'admin' })).statusCode).toBe(200);
  });
});

describe('invites', () => {
  let admin: Client;
  beforeEach(async () => {
    admin = await setupAdmin(app);
  });

  it('can be used only once', async () => {
    const { link } = (await call(app, admin, 'POST', '/api/admin/invites', {})).json();
    const token = tokenFromLink(link);
    expect((await acceptInvite(app, token, { username: 'kasia' })).statusCode).toBe(200);
    const again = await acceptInvite(app, token, { username: 'tomek' });
    expect(again.statusCode).toBe(400);
    expect((await app.inject({ url: `/api/invites/${token}` })).json()).toEqual({ valid: false });
  });

  it('expires', async () => {
    const { link } = (await call(app, admin, 'POST', '/api/admin/invites', { expiresInHours: 1 })).json();
    db.prepare('UPDATE invites SET expires_at = ?').run(Date.now() - 1);
    expect((await acceptInvite(app, tokenFromLink(link), { username: 'kasia' })).statusCode).toBe(400);
  });

  it('can be revoked', async () => {
    const { link, invite } = (await call(app, admin, 'POST', '/api/admin/invites', {})).json();
    expect((await call(app, admin, 'DELETE', `/api/admin/invites/${invite.id}`)).statusCode).toBe(200);
    expect((await acceptInvite(app, tokenFromLink(link), { username: 'kasia' })).statusCode).toBe(400);
  });

  it('enforces the password policy and unique usernames (case-insensitive)', async () => {
    const mk = async () =>
      tokenFromLink((await call(app, admin, 'POST', '/api/admin/invites', {})).json().link);
    expect((await acceptInvite(app, await mk(), { username: 'kasia', password: 'short' })).statusCode).toBe(
      400,
    );
    expect(
      (await acceptInvite(app, await mk(), { username: 'kasia', password: 'password1234' })).statusCode,
    ).toBe(400);
    expect(
      (await acceptInvite(app, await mk(), { username: 'kasia', password: 'kasia-is-the-best' })).statusCode,
    ).toBe(400);
    expect((await acceptInvite(app, await mk(), { username: 'ADMIN' })).statusCode).toBe(409);
    expect((await acceptInvite(app, await mk(), { username: 'bad name!' })).statusCode).toBe(400);
  });

  it('stores only token hashes', async () => {
    const { link } = (await call(app, admin, 'POST', '/api/admin/invites', {})).json();
    const token = tokenFromLink(link);
    const rows = db.prepare('SELECT token_hash FROM invites').all();
    expect(rows.every((r) => r.token_hash !== token && String(r.token_hash).length === 64)).toBe(true);
  });
});

describe('login and sessions', () => {
  let admin: Client;
  beforeEach(async () => {
    admin = await setupAdmin(app);
  });

  it('logs in, reports me, logs out', async () => {
    const res = await login('Admin', PASSWORD);
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'smaker_sid')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');

    const client: Client = { cookie: `smaker_sid=${cookie.value}`, csrf: res.json().csrfToken, userId: 1 };
    const me = await call(app, client, 'GET', '/api/auth/me');
    expect(me.json().user.username).toBe('admin');
    expect(me.json().user).not.toHaveProperty('password_hash');

    expect((await call(app, client, 'POST', '/api/auth/logout')).statusCode).toBe(200);
    expect((await call(app, client, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('gives the same generic error for unknown user and wrong password', async () => {
    const a = await login('nobody', PASSWORD);
    const b = await login('admin', 'wrong-password-123');
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
  });

  it('locks the account after 5 failures', async () => {
    for (let i = 0; i < 5; i++) expect((await login('admin', 'wrong-password-123')).statusCode).toBe(401);
    expect((await login('admin', PASSWORD)).statusCode).toBe(429);
  });

  it('rejects expired and idle sessions', async () => {
    db.prepare('UPDATE sessions SET last_seen_at = ?').run(Date.now() - 8 * 24 * 3600 * 1000);
    expect((await call(app, admin, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('stores only session id hashes', async () => {
    const value = admin.cookie.split('=')[1];
    const rows = db.prepare('SELECT id_hash FROM sessions').all();
    expect(rows.some((r) => r.id_hash === value)).toBe(false);
  });
});

describe('CSRF protection', () => {
  let admin: Client;
  beforeEach(async () => {
    admin = await setupAdmin(app);
  });

  it('blocks state-changing requests without our Origin', async () => {
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'a', password: 'b' },
    });
    expect(noOrigin.statusCode).toBe(403);
    const evil = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { origin: 'https://evil.example', cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { displayName: 'pwned' },
    });
    expect(evil.statusCode).toBe(403);
  });

  it('blocks logged-in requests without the CSRF token', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { origin: ORIGIN, cookie: admin.cookie },
      payload: { displayName: 'pwned' },
    });
    expect(res.statusCode).toBe(403);
    const wrong = await call(app, { ...admin, csrf: 'x'.repeat(43) }, 'PATCH', '/api/me', {
      displayName: 'pwned',
    });
    expect(wrong.statusCode).toBe(403);
    const ok = await call(app, admin, 'PATCH', '/api/me', { displayName: 'The Admin' });
    expect(ok.json().user.displayName).toBe('The Admin');
  });
});

describe('access control', () => {
  let admin: Client;
  let user: Client;
  beforeEach(async () => {
    admin = await setupAdmin(app);
    user = await createUser(app, admin, 'kasia');
  });

  const adminRoutes: [method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown][] = [
    ['GET', '/api/admin/users'],
    ['PATCH', '/api/admin/users/1', { active: false }],
    ['GET', '/api/admin/invites'],
    ['POST', '/api/admin/invites', {}],
    ['DELETE', '/api/admin/invites/1'],
    ['GET', '/api/admin/audit'],
  ];

  it.each(adminRoutes)('%s %s: 401 for anonymous, 403 for users', async (method, url, body) => {
    expect((await call(app, null, method, url, body)).statusCode).toBe(401);
    expect((await call(app, user, method, url, body)).statusCode).toBe(403);
  });

  it.each([
    ['GET', '/api/auth/me'],
    ['PATCH', '/api/me', { displayName: 'x' }],
    ['POST', '/api/me/password', { currentPassword: 'a', newPassword: 'b' }],
  ] as const)('%s %s needs login', async (method, url, body?: unknown) => {
    expect((await call(app, null, method, url, body)).statusCode).toBe(401);
  });

  it('deactivating a user ends their sessions and blocks login', async () => {
    const res = await call(app, admin, 'PATCH', `/api/admin/users/${user.userId}`, { active: false });
    expect(res.json().user.active).toBe(false);
    expect((await call(app, user, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await login('kasia', PASSWORD)).statusCode).toBe(401);
  });

  it('admins cannot lock themselves out', async () => {
    const res = await call(app, admin, 'PATCH', `/api/admin/users/${admin.userId}`, { role: 'user' });
    expect(res.statusCode).toBe(403);
  });

  it('admins can manage other admins, always leaving one', async () => {
    await call(app, admin, 'PATCH', `/api/admin/users/${user.userId}`, { role: 'admin' });
    expect(
      (await call(app, user, 'PATCH', `/api/admin/users/${admin.userId}`, { role: 'user' })).statusCode,
    ).toBe(200);
    expect(app.db.prepare(`SELECT COUNT(*) n FROM users WHERE role='admin'`).get()!.n).toBe(1);
  });

  it('writes an audit log', async () => {
    await login('kasia', 'wrong-password-123');
    const res = await call(app, admin, 'GET', '/api/admin/audit');
    const actions = (res.json().entries as { action: string }[]).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['login.failed', 'invite.accepted', 'admin.invite_created']),
    );
  });
});

describe('password change', () => {
  it('requires the current password and logs out other sessions', async () => {
    const admin = await setupAdmin(app);
    const other = await login('admin', PASSWORD);
    const otherClient: Client = {
      cookie: `smaker_sid=${other.cookies.find((c) => c.name === 'smaker_sid')!.value}`,
      csrf: other.json().csrfToken,
      userId: admin.userId,
    };

    const wrong = await call(app, admin, 'POST', '/api/me/password', {
      currentPassword: 'nope-nope-nope',
      newPassword: 'a-brand-new-passphrase',
    });
    expect(wrong.statusCode).toBe(400);

    const ok = await call(app, admin, 'POST', '/api/me/password', {
      currentPassword: PASSWORD,
      newPassword: 'a-brand-new-passphrase',
    });
    expect(ok.statusCode).toBe(200);
    expect((await call(app, admin, 'GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await call(app, otherClient, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await login('admin', 'a-brand-new-passphrase')).statusCode).toBe(200);
  });
});
