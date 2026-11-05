import { buildApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { openDatabase } from '../src/db';

export async function createTestApp(overrides: Partial<Config> = {}) {
  const config = { ...loadConfig({ NODE_ENV: 'test' }), ...overrides };
  const db = openDatabase(':memory:');
  const app = await buildApp({ config, db });
  return { app, db, config };
}
