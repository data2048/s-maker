import { expect, test, type Page } from '@playwright/test';
import { login, playerFrame, playerReady } from './helpers';

test.describe.configure({ mode: 'serial' });

async function newSongWithChat(page: Page) {
  await login(page);
  await page.getByRole('button', { name: 'New song' }).click();
  await expect(page).toHaveURL(/\/songs\/\d+$/);
  await playerReady(page);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
}

const say = async (page: Page, text: string) => {
  await page.getByLabel('Message to the agent').fill(text);
  await page.getByLabel('Message to the agent').press('Enter');
};

test('chat: a question, a decision, then a change that becomes a version', async ({ page }) => {
  await newSongWithChat(page);
  const log = page.getByRole('log');

  await say(page, 'What key is this?');
  await expect(log).toContainText('It is in C major, and the "bass" follows the chords.');
  await expect(page.locator('.proposal')).toBeHidden();

  await say(page, 'Let us keep it slow');
  await expect(log).toContainText('I noted a slow tempo.');
  await page.getByRole('button', { name: 'Brief', exact: true }).click();
  await expect(page.getByLabel('Tempo')).toHaveValue(/slow, about 70 BPM/);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();

  await say(page, 'Make the bass a synth');
  await expect(page.locator('.proposal')).toContainText('Bass to synth');
  await expect(playerFrame(page).locator('.cm-content')).toContainText('gm_synth_bass_2');
  await expect(page.getByRole('log')).toContainText('waiting for you');
  await page.screenshot({ path: 'test-results/chat.png', fullPage: true });

  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('from the agent')).toBeVisible();
  await expect(page.getByRole('log')).toContainText('accepted');

  // The conversation is still there after a reload.
  await page.reload();
  await playerReady(page);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('What key is this?');
  await expect(page.locator('.proposal')).toBeHidden();
});

test('compose from a description, listen to the first version, accept it', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Compose with agent' }).click();
  await expect(page.getByRole('button', { name: 'Compose' })).toBeDisabled();
  await page.getByLabel('Description').fill('A calm piece in C minor');
  await page.locator('.compose-elements summary').click();
  await page.getByLabel('Style').fill('ambient');
  await page.getByRole('button', { name: 'Compose' }).click();

  await expect(page).toHaveURL(/\/songs\/\d+$/, { timeout: 30_000 });
  await playerReady(page);
  await expect(page.getByLabel('Song title')).toHaveValue('Fake Song');
  const player = playerFrame(page);
  await expect(page.locator('.proposal')).toContainText('Composed a short piece', { timeout: 30_000 });
  await expect(player.locator('.cm-content')).toContainText('verse_bass');
  await player.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByText('● playing')).toBeVisible({ timeout: 30_000 });
  await expect(player.locator('#error')).toBeHidden();
  await player.getByRole('button', { name: 'Stop' }).click();

  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('from the agent')).toBeVisible();

  // The form it wrote is offered as a section, and the brief holds what was asked and decided.
  await expect(
    page.getByLabel('Agent scope').locator('option', { hasText: 'Section: verse_bass' }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Brief', exact: true }).click();
  await expect(page.getByLabel('Style')).toHaveValue('ambient');
  await expect(page.getByLabel('Tempo')).toHaveValue('90 BPM');
});

test('talk it through: an empty song opens with the chat', async ({ page }) => {
  await login(page);
  await page.goto('/compose');
  await page.getByRole('button', { name: 'Talk it through in chat instead' }).click();
  await expect(page).toHaveURL(/\/songs\/\d+\?chat=1$/);
  await playerReady(page);
  await expect(page.getByLabel('Message to the agent')).toBeVisible();
});
