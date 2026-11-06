import { expect, test, type Page } from '@playwright/test';
import { login, playerFrame, playerReady } from './helpers';

test.describe.configure({ mode: 'serial' });

async function newSong(page: Page) {
  await login(page);
  await page.getByRole('button', { name: 'New song' }).click();
  await expect(page).toHaveURL(/\/songs\/\d+$/);
  await playerReady(page);
}

test('ask the agent about a track, listen, accept', async ({ page }) => {
  await newSong(page);
  const player = playerFrame(page);

  // From the mixer: the scope is that track.
  await page.getByRole('button', { name: 'Ask agent about bass' }).click();
  await expect(page.getByLabel('Agent scope')).toHaveValue('bass');
  await page.getByLabel('Instruction for the agent').fill('Change the bass');
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click();

  // The proposal is shown as a diff and is in the editor for listening.
  await expect(page.locator('.proposal')).toContainText('Changed the bass', { timeout: 30_000 });
  await expect(page.locator('.agent-diff')).toContainText('gm_synth_bass_1');
  await expect(player.locator('.cm-content')).toContainText('gm_synth_bass_1');
  await player.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByText('● playing')).toBeVisible({ timeout: 30_000 });
  await expect(player.locator('#error')).toBeHidden();
  await player.getByRole('button', { name: 'Stop' }).click();
  await page.screenshot({ path: 'test-results/agent.png', fullPage: true });

  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('from the agent')).toBeVisible();
  await expect(page.locator('.proposal')).toBeHidden();

  // History says who wrote it; the spending shows.
  await page.getByRole('button', { name: /History/ }).click();
  await expect(page.locator('.version').first()).toContainText('Changed the bass');
  await expect(page.locator('.agent-form')).toContainText('$0.01');
});

test('a proposal that fails in the player goes back to the model', async ({ page }) => {
  await newSong(page);
  await page.getByLabel('Instruction for the agent').fill('USE A BAD SOUND');
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
  // The fake model first answers with a sound that does not exist; the player finds it.
  await expect(page.locator('.proposal')).toContainText('Fixed the sound', { timeout: 30_000 });
  await expect(page.locator('.agent-diff')).toContainText('gm_tuba');
  await expect(page.locator('.agent-diff')).not.toContainText('gm_does_not_exist');
});

test('rejecting puts the editor back', async ({ page }) => {
  await newSong(page);
  const player = playerFrame(page);
  await page.getByLabel('Instruction for the agent').fill('Change the bass');
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await expect(player.locator('.cm-content')).toContainText('gm_synth_bass_1', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(player.locator('.cm-content')).not.toContainText('gm_synth_bass_1');
  await expect(page.getByRole('button', { name: 'Saved' })).toBeDisabled();
});

test('the admin sees models, limits and spending', async ({ page }) => {
  await login(page);
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'agent' }).click();
  await expect(page.getByLabel('Fast model')).toHaveValue(/.+\/.+/);
  await expect(page.getByLabel('Limit per user, USD per 7 days')).toHaveValue('3');
  await expect(page.getByRole('heading', { name: /Last 7 days/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'e2e-admin' }).first()).toBeVisible();
});
