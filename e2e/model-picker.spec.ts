import { expect, test } from '@playwright/test';
import { login, playerReady } from './helpers';

test('the admin adds a model in the song window and compares it on the same request', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'New song' }).click();
  await expect(page).toHaveURL(/\/songs\/\d+$/);
  await playerReady(page);

  await page.getByRole('button', { name: 'Models…' }).first().click();
  await page.getByLabel('Model to add').fill('test/compare-model');
  await expect(page.locator('.model-manager')).toContainText('$1 in / $2 out');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByLabel('Agent model')).toHaveValue('model:test/compare-model');
  await page.screenshot({ path: 'test-results/model-picker.png' });

  const request = 'Change the bass';
  await page.getByLabel('Instruction for the agent').fill(request);
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await expect(page.locator('.proposal')).toContainText('test/compare-model', { timeout: 30_000 });

  // Back to the same starting point: the same request can go to another model.
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('button', { name: 'Reuse last request' }).click();
  await expect(page.getByLabel('Instruction for the agent')).toHaveValue(request);
  await page.getByLabel('Agent model').selectOption('fast');
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await expect(page.locator('.proposal')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.proposal')).not.toContainText('test/compare-model');
  await page.getByRole('button', { name: 'Reject' }).click();

  // Taking it off the list leaves the shared e2e database as it was.
  await page.getByRole('button', { name: 'Remove test/compare-model' }).click();
  await expect(page.locator('.model-manager li')).toHaveCount(0);
});
