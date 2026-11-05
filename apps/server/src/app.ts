import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from './config';
import type { Db } from './db';
import authPlugin from './auth/plugin';
import { authRoutes } from './auth/routes';
import { songRoutes } from './songs/routes';
import { healthRoutes } from './routes/health';
import { applySandboxHeaders, SANDBOX_PATH } from './sandbox-headers';

export interface AppDeps {
  config: Config;
  db: Db;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Db;
  }
}

export async function buildApp({ config, db }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.env === 'test'
        ? false
        : {
            level: config.logLevel,
            redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
          },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    // Request ids in logs make it possible to correlate a user report with server logs.
    genReqId: () => crypto.randomUUID(),
  });

  app.decorate('config', config);
  app.decorate('db', db);

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.secureCookies ? { maxAge: 15552000, includeSubDomains: false } : false,
    referrerPolicy: { policy: 'same-origin' },
  });

  // Never leak internals (stack traces, SQL) to the client.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply.status(status).send({ error: 'Internal Server Error' });
    }
    return reply.status(status).send({ error: error.message });
  });

  // Generous global limit per client IP; auth endpoints set stricter limits per route.
  await app.register(fastifyRateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  await app.register(healthRoutes);
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(songRoutes);

  const webDist = config.webDist;
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      setHeaders(res, path) {
        const p = path.replaceAll('\\', '/');
        if (p.endsWith(SANDBOX_PATH)) {
          applySandboxHeaders(res);
          return;
        }
        if (p.includes('/assets/')) {
          // Vite puts content-hashed files in /assets, so they can be cached forever.
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
          // The sandboxed player has an opaque origin ("null") and loads its modules with CORS.
          // These are public static files, so allowing any origin exposes nothing.
          res.header('Access-Control-Allow-Origin', '*');
          res.header('Cross-Origin-Resource-Policy', 'cross-origin');
        } else {
          res.header('Cache-Control', 'no-cache');
        }
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/api/') || request.url === '/api';
    const wantsHtml = request.method === 'GET' && (request.headers.accept ?? '').includes('text/html');
    if (!isApi && wantsHtml && webDist && existsSync(join(webDist, 'index.html'))) {
      // Client-side routes (e.g. /songs/123) are handled by the React app.
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).send({ error: 'Not Found' });
  });

  return app;
}
