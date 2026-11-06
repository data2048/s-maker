import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers';

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'smaker-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(dir, 'sandbox.html'), '<!doctype html><title>player</title>');
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'assets', 'big-abc123.js'), 'console.log(2)');
  writeFileSync(join(dir, 'assets', 'big-abc123.js.gz'), gzipSync('console.log(2)'));
  writeFileSync(join(dir, 'assets', 'big-abc123.js.br'), brotliCompressSync('console.log(2)'));
  ({ app } = await createTestApp({ webDist: dir }));
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('static files', () => {
  it('sends the compressed file the browser accepts, with the same headers', async () => {
    const br = await app.inject({
      url: '/assets/big-abc123.js',
      headers: { 'accept-encoding': 'gzip, br' },
    });
    expect(br.statusCode).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['content-type']).toContain('javascript');
    expect(String(br.headers.vary).toLowerCase()).toContain('accept-encoding');
    expect(br.headers['access-control-allow-origin']).toBe('*');
    expect(br.headers['cache-control']).toContain('immutable');

    const gz = await app.inject({ url: '/assets/big-abc123.js', headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');

    const plain = await app.inject({
      url: '/assets/big-abc123.js',
      headers: { 'accept-encoding': 'identity' },
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toBe('console.log(2)');
  });

  it('keeps the player page sandboxed when the browser accepts compression', async () => {
    const res = await app.inject({ url: '/sandbox.html', headers: { 'accept-encoding': 'gzip, br' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain('sandbox allow-scripts');
  });

  it('app pages get the strict CSP (no eval, no framing)', async () => {
    const res = await app.inject({ url: '/', headers: { accept: 'text/html' } });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('client routes fall back to index.html', async () => {
    const res = await app.inject({ url: '/playground', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>app</title>');
  });

  it('the player page is sandboxed by CSP and frameable only by us', async () => {
    const res = await app.inject({ url: '/sandbox.html' });
    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("default-src 'none'");
    expect(res.headers['x-frame-options']).toBeUndefined();
  });

  it('hashed assets are cacheable and loadable by the opaque-origin player', async () => {
    const res = await app.inject({ url: '/assets/app-abc123.js' });
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('static files do not count towards the rate limit, the API does', async () => {
    for (let i = 0; i < 700; i++) {
      const res = await app.inject({ url: '/assets/app-abc123.js' });
      if (res.statusCode !== 200) throw new Error(`request ${i}: ${res.statusCode}`);
    }
    let last = 0;
    for (let i = 0; i < 601; i++) last = (await app.inject({ url: '/api/songs' })).statusCode;
    expect(last).toBe(429);
  });

  it('API responses do not get the permissive CORS header', async () => {
    const res = await app.inject({ url: '/api/auth/me', headers: { origin: 'null' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
