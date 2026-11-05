import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { SESSION_FILE, STATE_FILE } from './global-setup';

/**
 * Logs in as the e2e admin. The first call goes through the login form; later calls reuse that session
 * cookie, so the suite stays under the login rate limit (10 per minute), like a real user would.
 */
export async function login(page: Page): Promise<void> {
  if (existsSync(SESSION_FILE)) {
    await page.context().addCookies(JSON.parse(readFileSync(SESSION_FILE, 'utf8')));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Hi,/ })).toBeVisible();
    return;
  }
  const { username, password } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as {
    username: string;
    password: string;
  };
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: /Hi,/ })).toBeVisible();
  writeFileSync(SESSION_FILE, JSON.stringify(await page.context().cookies()));
}

/** Waits until the sandboxed player reported "ready" and is not playing. */
export const playerReady = (page: Page) =>
  expect(page.getByText('stopped', { exact: true })).toBeVisible({ timeout: 20_000 });

export const playerFrame = (page: Page) => page.frameLocator('iframe[title="Strudel player"]');
