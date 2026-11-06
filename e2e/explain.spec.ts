import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { login, playerReady } from './helpers';

test('explain a song at two levels, safely, and download the file', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'New song' }).click();
  await expect(page).toHaveURL(/\/songs\/\d+$/);
  await playerReady(page);
  await page.getByRole('button', { name: 'Explain', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Explanations' });
  await expect(panel).toContainText('No explanations yet.');

  await page.getByLabel('Level of detail').selectOption('short');
  await panel.getByRole('button', { name: 'Explain v1' }).click();
  const shortOne = panel.locator('.markdown');
  await expect(shortOne).toContainText('Short explanation', { timeout: 30_000 });
  // The code is part of the explanation.
  await expect(shortOne.locator('pre code')).toContainText('RolandTR909');

  // What the model wrote must not run or call anywhere.
  await expect(shortOne.locator('strong')).toContainText('bold');
  await expect(shortOne.locator('img, script, iframe, style, [onclick], [style]')).toHaveCount(0);
  await expect(shortOne.locator('a[href^="javascript"]')).toHaveCount(0);
  const safeLink = shortOne.getByRole('link', { name: 'Strudel docs' });
  await expect(safeLink).toHaveAttribute('rel', /noopener/);
  expect(await page.evaluate(() => (window as unknown as { xss?: boolean }).xss)).toBeUndefined();
  await page.screenshot({ path: 'test-results/explain.png', fullPage: true });

  const download = page.waitForEvent('download');
  await panel.getByRole('link', { name: 'Download .md' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^Untitled-song-v1-short\.md$/);
  const text = readFileSync(await file.path(), 'utf8');
  expect(text).toContain('# Untitled song (v1)');
  expect(text).toContain('```strudel');

  await page.getByLabel('Level of detail').selectOption('detailed');
  await panel.getByRole('button', { name: 'Explain v1' }).click();
  await expect(panel.locator('.markdown')).toContainText('Detailed explanation', { timeout: 30_000 });

  // Both stay with the song.
  await page.reload();
  await playerReady(page);
  await page.getByRole('button', { name: 'Explain', exact: true }).click();
  await expect(panel.getByRole('button', { name: /Detailed/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: /Short/ })).toBeVisible();
});
