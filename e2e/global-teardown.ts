import { readFileSync, rmSync } from 'node:fs';
import { SESSION_FILE, STATE_FILE } from './global-setup';

export default async function globalTeardown(): Promise<void> {
  const { pid, dataDir } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { pid: number; dataDir: string };
  try {
    process.kill(pid);
  } catch {
    // already stopped
  }
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(STATE_FILE, { force: true });
  rmSync(SESSION_FILE, { force: true });
}
