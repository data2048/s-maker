import { expect, test, type Page } from '@playwright/test';
import { login, playerFrame, playerReady } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function expectNoSidewaysScroll(page: Page, where: string) {
  const result = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    screen: document.documentElement.clientWidth,
  }));
  expect(result.page, `${where} is wider than the screen`).toBeLessThanOrEqual(result.screen);
}

test('no page is wider than a phone', async ({ page }) => {
  await login(page);
  for (const url of ['/', '/compose', '/import', '/playground', '/profile', '/admin']) {
    await page.goto(url);
    await page.waitForTimeout(300);
    await expectNoSidewaysScroll(page, url);
  }
});

test('on a phone a song plays by touch, with every panel fitting the screen', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'New song' }).tap();
  await expect(page).toHaveURL(/\/songs\/\d+$/);
  await playerReady(page);
  await expectNoSidewaysScroll(page, 'the song page');

  const player = playerFrame(page);
  const play = player.getByRole('button', { name: 'Play' });

  // The player comes before the mixer, near the top of the page.
  const frame = await page.locator('iframe').boundingBox();
  const mixer = await page.getByRole('heading', { name: 'Tracks' }).boundingBox();
  expect(frame!.y).toBeLessThan(mixer!.y);

  // The text fields stay usable instead of being squeezed between the buttons.
  const field = await page.getByLabel('Instruction for the agent').boundingBox();
  expect(field!.width).toBeGreaterThan(250);

  await play.tap();
  await expect(page.getByText('● playing')).toBeVisible({ timeout: 30_000 });
  await expect(player.locator('#error')).toBeHidden();
  const running = player.locator('body');
  await expect(running).toBeVisible();
  await player.getByRole('button', { name: 'Stop' }).tap();

  for (const name of ['Chat', 'Explain', 'Export', 'Brief']) {
    await page.getByRole('button', { name, exact: true }).tap();
    await page.waitForTimeout(200);
    await expectNoSidewaysScroll(page, `the ${name} panel`);
    // It opens where you can see it, not somewhere below.
    await expect(page.locator('.song-grid .history h3')).toBeInViewport();
  }
  await page.screenshot({ path: 'test-results/mobile-song.png', fullPage: true });
});
