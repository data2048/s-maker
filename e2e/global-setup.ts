// Starts the built server on its own port with an empty database and captures the admin setup link.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const STATE_FILE = join(tmpdir(), 's-maker-e2e-state.json');
/** Session cookie of the first login, reused by later tests. */
export const SESSION_FILE = join(tmpdir(), 's-maker-e2e-session.json');
const PORT = 44577;

export default async function globalSetup(): Promise<void> {
  rmSync(SESSION_FILE, { force: true });
  const dataDir = mkdtempSync(join(tmpdir(), 's-maker-e2e-'));
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'apps/server/dist/index.js'],
    {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(PORT),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        PUBLIC_URL: `http://127.0.0.1:${PORT}`,
        WEB_DIST: join(process.cwd(), 'apps/web/dist'),
        ADMIN_USERNAME: 'e2e-admin',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );

  const link = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not print the setup link')), 20_000);
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /ADMIN SETUP LINK: ([^"\s]+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited with code ${code}`)));
  });

  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`http://127.0.0.1:${PORT}/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Create the admin account through the real invite flow.
  const password = `e2e-${randomBytes(12).toString('base64url')}`;
  const token = link.split('/invite/')[1]!;
  const res = await fetch(`http://127.0.0.1:${PORT}/api/invites/${token}/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORT}` },
    body: JSON.stringify({ username: 'e2e-admin', displayName: 'E2E Admin', password }),
  });
  if (!res.ok) throw new Error(`admin setup failed: ${res.status} ${await res.text()}`);

  writeFileSync(STATE_FILE, JSON.stringify({ pid: child.pid, dataDir, username: 'e2e-admin', password }));
}
