import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(44566),
  DATA_DIR: z.string().default('./data'),
  PUBLIC_URL: z.url().optional(),
  TRUST_PROXY: z.string().optional(),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  WEB_DIST: z.string().optional(),
  APP_VERSION: z.string().default('dev'),
  ADMIN_USERNAME: z
    .string()
    .regex(/^[a-z0-9_.-]{3,32}$/i)
    .optional(),
});

export interface Config {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  dataDir: string;
  /** Public origin the browser uses, e.g. https://music.example.com (no trailing slash). */
  publicUrl: string;
  /** True when the app is served over HTTPS: cookies get the Secure flag. */
  secureCookies: boolean;
  /** IPs/CIDRs of the reverse proxy whose X-Forwarded-For header we trust. */
  trustProxy: boolean | string | string[];
  logLevel: (typeof logLevels)[number];
  webDist: string | undefined;
  version: string;
  adminUsername: string | undefined;
}

function parseTrustProxy(value: string | undefined): Config['trustProxy'] {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  const list = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length === 1 ? list[0]! : list;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;

  if (e.NODE_ENV === 'production' && !e.PUBLIC_URL) {
    throw new Error('Invalid configuration:\n  PUBLIC_URL is required in production');
  }
  const publicUrl = (e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, '');

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    dataDir: e.DATA_DIR,
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    logLevel: e.LOG_LEVEL,
    webDist: e.WEB_DIST,
    version: e.APP_VERSION,
    adminUsername: e.ADMIN_USERNAME,
  };
}
