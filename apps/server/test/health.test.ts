import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config';
import { createTestApp } from './helpers';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('returns ok with version', async () => {
    ({ app } = await createTestApp({ version: 'abc123' }));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: 'abc123' });
  });

  it('sends security headers', async () => {
    ({ app } = await createTestApp());
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('returns JSON 404 for unknown api routes', async () => {
    ({ app } = await createTestApp());
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found' });
  });
});

describe('loadConfig', () => {
  it('requires PUBLIC_URL in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/PUBLIC_URL/);
  });

  it('marks https origins as secure', () => {
    const c = loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://music.example.com/' });
    expect(c.publicUrl).toBe('https://music.example.com');
    expect(c.secureCookies).toBe(true);
  });

  it('parses TRUST_PROXY', () => {
    expect(loadConfig({ TRUST_PROXY: '127.0.0.1' }).trustProxy).toBe('127.0.0.1');
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: '10.0.0.1, 10.0.0.2' }).trustProxy).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(loadConfig({}).trustProxy).toBe(false);
  });
});
