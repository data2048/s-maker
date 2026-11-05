import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app';
import { bootstrapAdmin } from '../src/auth/bootstrap';
import { loadConfig, type Config } from '../src/config';
import { openDatabase } from '../src/db';

export const ORIGIN = 'http://localhost:44566';
export const PASSWORD = 'correct-horse-battery-42';

const silentLog = {
  warn: () => {},
  info: () => {},
  error: () => {},
} as unknown as FastifyInstance['log'];

export async function createTestApp(overrides: Partial<Config> = {}) {
  const config = { ...loadConfig({ NODE_ENV: 'test', ADMIN_USERNAME: 'admin' }), ...overrides };
  const db = openDatabase(':memory:');
  const app = await buildApp({ config, db });
  return { app, db, config };
}

export interface Client {
  cookie: string;
  csrf: string;
  userId: number;
}

function sessionCookie(res: LightMyRequestResponse): string {
  const c = res.cookies.find((c) => c.name.endsWith('smaker_sid'));
  if (!c) throw new Error(`no session cookie (status ${res.statusCode}: ${res.body})`);
  return `${c.name}=${c.value}`;
}

export function tokenFromLink(link: string): string {
  return link.split('/invite/')[1]!;
}

export async function acceptInvite(
  app: FastifyInstance,
  token: string,
  body: { username: string; displayName?: string; password?: string },
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/invites/${token}/accept`,
    headers: { origin: ORIGIN },
    payload: { displayName: body.username, password: PASSWORD, ...body },
  });
}

function toClient(res: LightMyRequestResponse): Client {
  const json = res.json() as { user: { id: number }; csrfToken: string };
  return { cookie: sessionCookie(res), csrf: json.csrfToken, userId: json.user.id };
}

/** Creates the first admin through the bootstrap link and returns a logged-in client. */
export async function setupAdmin(app: FastifyInstance): Promise<Client> {
  const link = bootstrapAdmin(app.db, app.config, silentLog);
  if (!link) throw new Error('bootstrap did not create a link');
  const res = await acceptInvite(app, tokenFromLink(link), { username: 'admin' });
  if (res.statusCode !== 200) throw new Error(`admin setup failed: ${res.body}`);
  return toClient(res);
}

/** Admin invites a new user who accepts; returns that user's logged-in client. */
export async function createUser(app: FastifyInstance, admin: Client, username: string): Promise<Client> {
  const inv = await call(app, admin, 'POST', '/api/admin/invites', { role: 'user' });
  const { link } = inv.json() as { link: string };
  const res = await acceptInvite(app, tokenFromLink(link), { username });
  if (res.statusCode !== 200) throw new Error(`user setup failed: ${res.body}`);
  return toClient(res);
}

/** Authenticated request with origin + CSRF headers like the real web app sends. */
export function call(
  app: FastifyInstance,
  client: Client | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  payload?: unknown,
) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (client) {
    headers.cookie = client.cookie;
    headers['x-csrf-token'] = client.csrf;
  }
  return app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

export { silentLog };
