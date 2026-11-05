import { expect, test, type Page } from '@playwright/test';
import { login, playerFrame, playerReady } from './helpers';

test.describe.configure({ mode: 'serial' });

async function newSong(page: Page) {
  await login(page);
  await page.getByRole('button', { name: 'New song' }).click();
  await expect(page).toHaveURL(/\/songs\/\d+$/);
  await playerReady(page);
}

test('create a song, use the mixer, save versions, restore', async ({ page }) => {
  await newSong(page);
  const player = playerFrame(page);
  await expect(player.locator('.cm-content')).toContainText('drums:');

  // Mixer shows the template tracks.
  const names = page.locator('.track-name');
  await expect(names).toHaveText(['drums', 'bass', 'keys']);

  // Title
  await page.getByLabel('Song title').fill('E2E groove');
  await page.getByLabel('Song title').press('Enter');

  // Mute bass -> label in the code becomes _bass
  await page.getByRole('button', { name: 'Mute bass' }).click();
  await expect(player.locator('.cm-content')).toContainText('_bass:');
  // Change instrument of keys
  await page.getByLabel('Instrument of keys').selectOption('gm_vibraphone');
  await expect(player.locator('.cm-content')).toContainText('s("gm_vibraphone")');

  // Save v2 with a message
  await page.getByLabel('Version message').fill('muted bass, vibes');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved v2')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeDisabled();

  // Add a track and save with Ctrl+S from inside the editor
  await page.getByRole('button', { name: '+ Track' }).click();
  await page.getByLabel('New track name').fill('lead');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(names).toHaveText(['drums', 'bass', 'keys', 'lead']);
  await player.locator('.cm-content').click();
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved v3')).toBeVisible();

  // History: restore v1 as a new version
  await page.getByRole('button', { name: /History/ }).click();
  await page.locator('.version', { hasText: 'v1' }).click();
  await expect(page.locator('.diff')).toContainText('lead:');
  await page.getByRole('button', { name: 'Restore as new version' }).click();
  await expect(names).toHaveText(['drums', 'bass', 'keys']);
  await expect(page.locator('.version').first()).toContainText('Restored v1');
  await page.screenshot({ path: 'test-results/song-page.png', fullPage: true });

  // The song is listed on the home page with its new title.
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.locator('.song-row', { hasText: 'E2E groove' })).toContainText('v4');
});

test('unsaved edits survive leaving the page', async ({ page }) => {
  await newSong(page);
  await page.getByRole('button', { name: 'Solo drums' }).click();
  await expect(playerFrame(page).locator('.cm-content')).toContainText('Sdrums:');
  await page.waitForTimeout(800); // draft is written after a short pause
  await page.getByRole('link', { name: 'Home' }).click();
  await page.goBack();
  await playerReady(page);
  await page.getByRole('button', { name: 'Restore them' }).click();
  await expect(playerFrame(page).locator('.cm-content')).toContainText('Sdrums:');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});

test('a named-track song plays without errors', async ({ page }) => {
  await newSong(page);
  const player = playerFrame(page);
  await player.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByText('● playing')).toBeVisible({ timeout: 30_000 });
  await expect(player.locator('#error')).toBeHidden();
  // Muting while playing re-evaluates and keeps playing.
  await page.getByRole('button', { name: 'Mute drums' }).click();
  await page.waitForTimeout(500);
  await expect(page.getByText('● playing')).toBeVisible();
  await expect(player.locator('#error')).toBeHidden();
  await player.getByRole('button', { name: 'Stop' }).click();
});
