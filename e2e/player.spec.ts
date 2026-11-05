import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { STATE_FILE } from './global-setup';

const password = `e2e-${randomBytes(12).toString('base64url')}`;
let adminCreated = false;

async function login(page: Page): Promise<void> {
  if (!adminCreated) {
    const { link } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { link: string };
    await page.goto(new URL(link).pathname);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Repeat password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    adminCreated = true;
  } else {
    await page.goto('/login');
    await page.getByLabel('Username').fill('e2e-admin');
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Log in' }).click();
  }
  await expect(page.getByRole('heading', { name: /Hi,/ })).toBeVisible();
}

const playerReady = (page: Page) =>
  expect(page.getByText('stopped', { exact: true })).toBeVisible({ timeout: 20_000 });

test.describe.configure({ mode: 'serial' });

test('playground loads the sandboxed player and plays', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Playground' }).click();
  await playerReady(page);

  const player = page.frameLocator('iframe[title="Strudel player"]');
  await expect(player.locator('.cm-content')).toContainText('gm_acoustic_grand_piano');

  await player.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByText('● playing')).toBeVisible({ timeout: 30_000 });
  await expect(player.locator('#error')).toBeHidden();
  await page.screenshot({ path: 'test-results/playground-playing.png' });

  await player.getByRole('button', { name: 'Stop' }).click();
  await playerReady(page);
});

test('code in the player cannot reach the session or the app', async ({ page }) => {
  await login(page);
  await page.goto('/playground');
  await playerReady(page);

  const frame = page.frames().find((f) => f.url().includes('/sandbox.html'));
  expect(frame).toBeTruthy();
  const probe = await frame!.evaluate(async () => {
    const result: Record<string, unknown> = { origin: self.origin };
    try {
      result.cookie = document.cookie;
    } catch {
      result.cookie = 'blocked';
    }
    try {
      result.parentDoc = typeof window.parent.document;
    } catch {
      result.parentDoc = 'blocked';
    }
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      result.api = r.status;
    } catch {
      result.api = 'blocked';
    }
    return result;
  });
  expect(probe.origin).toBe('null');
  expect(probe.cookie).toBe('blocked');
  expect(probe.parentDoc).toBe('blocked');
  // Either CORS blocks the response or the request arrives without the session cookie.
  expect(['blocked', 401]).toContain(probe.api);
});

test('sandbox.html opened directly is still sandboxed (CSP sandbox)', async ({ page }) => {
  await page.goto('/sandbox.html');
  expect(await page.evaluate(() => self.origin)).toBe('null');
});

test('edits in the player flow back to the app and get validated', async ({ page }) => {
  await login(page);
  await page.goto('/playground');
  await playerReady(page);
  const player = page.frameLocator('iframe[title="Strudel player"]');
  await player.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nfetch("x")');
  await expect(page.locator('.issues li.warning')).toContainText('"fetch" is not available');
});
