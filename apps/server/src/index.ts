import { join, resolve } from 'node:path';
import { buildApp } from './app';
import { bootstrapAdmin } from './auth/bootstrap';
import { loginFailures, sessions } from './auth/store';
import { loadConfig } from './config';
import { openDatabase } from './db';

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.webDist) {
    // In development the web app is built to apps/web/dist next to this package.
    config.webDist = resolve(import.meta.dirname, '../../web/dist');
  }
  const db = openDatabase(join(config.dataDir, 'smaker.db'));
  const app = await buildApp({ config, db });
  bootstrapAdmin(db, config, app.log);

  // Housekeeping: drop expired sessions and old login failures every hour.
  const cleanup = () => {
    sessions.deleteExpired(db);
    loginFailures.deleteOld(db);
  };
  cleanup();
  setInterval(cleanup, 3600 * 1000).unref();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
    } finally {
      db.close();
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
