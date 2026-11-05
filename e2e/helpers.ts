import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { STATE_FILE } from './global-setup';

export async function login(page: Page): Promise<void> {
  const { username, password } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as {
    username: string;
    password: string;
  };
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: /Hi,/ })).toBeVisible();
}

/** Waits until the sandboxed player reported "ready" and is not playing. */
export const playerReady = (page: Page) =>
  expect(page.getByText('stopped', { exact: true })).toBeVisible({ timeout: 20_000 });

export const playerFrame = (page: Page) => page.frameLocator('iframe[title="Strudel player"]');
