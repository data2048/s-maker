import { expect, test } from '@playwright/test';
import { writeMidi } from '../packages/shared/src/midi/write';
import { login, playerFrame } from './helpers';

const Q = 480;

function demoMidi() {
  const melody = [60, 62, 64, 65, 67, 65, 64, 62].map((pitch, i) => ({
    tick: (i * Q) / 2,
    duration: Q / 2,
    pitch,
    velocity: 60 + (i % 4) * 20,
  }));
  const bass = [0, 1].map((bar) => ({ tick: bar * 4 * Q, duration: 4 * Q, pitch: 36 + bar * 5 }));
  const drums = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((beat) => [
    { tick: beat * Q, duration: 30, pitch: beat % 2 ? 38 : 36 },
    { tick: beat * Q + Q / 2, duration: 30, pitch: 42 },
  ]);
  return Buffer.from(
    writeMidi({
      bpm: 104,
      tracks: [
        { name: 'Flute', program: 73, notes: melody },
        { name: 'Bass', program: 33, notes: bass },
        { name: 'Drums', channel: 9, notes: drums },
      ],
    }),
  );
}

test('import a MIDI file: tracks, live preview, play, create a song', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Import MIDI' }).first().click();
  await expect(page.getByRole('heading', { name: 'Import MIDI' })).toBeVisible();

  await page
    .locator('#midi-file')
    .setInputFiles({ name: 'demo song.mid', mimeType: 'audio/midi', buffer: demoMidi() });

  // Analysis and tracks
  await expect(page.getByText('104 BPM · 4/4')).toBeVisible();
  const rows = page.locator('.midi-parts tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Flute');
  await expect(rows.nth(0)).toContainText('gm_flute');
  await expect(rows.nth(2)).toContainText('Drums → drum machine');

  // Live preview in the sandboxed player
  const player = playerFrame(page);
  await expect(player.locator('.cm-content')).toContainText('flute:', { timeout: 20_000 });
  await expect(player.locator('.cm-content')).toContainText('bank("RolandTR909")');

  // Unticking a track updates the preview
  await page.getByLabel('Import Bass').uncheck();
  await expect(player.locator('.cm-content')).not.toContainText('bass:');
  await page.getByLabel('Import Bass').check();
  await expect(player.locator('.cm-content')).toContainText('bass:');

  // Grid change
  await page.getByLabel('Grid').selectOption({ label: '1/16' });
  await expect(player.locator('.cm-content')).toContainText('1/16 grid');

  // It plays without errors
  await player.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByText('● playing')).toBeVisible({ timeout: 30_000 });
  await expect(player.locator('#error')).toBeHidden();
  await page.screenshot({ path: 'test-results/midi-import.png', fullPage: true });
  await player.getByRole('button', { name: 'Stop' }).click();

  // Create the song
  await expect(page.getByLabel('Song title')).toHaveValue('demo song');
  await page.getByRole('button', { name: 'Create song' }).click();
  await expect(page).toHaveURL(/\/songs\/\d+$/);
  await expect(page.locator('.track-name')).toHaveText(['flute', 'bass', 'drums']);
  await expect(page.getByLabel('Instrument of flute')).toHaveValue('gm_flute');
  await expect(page.getByLabel('Drum machine of drums')).toHaveValue('RolandTR909');

  // The upload is listed for reuse
  await page.getByRole('link', { name: 'Import MIDI' }).first().click();
  await expect(page.getByRole('button', { name: 'demo song.mid', exact: true })).toBeVisible();
});

test('a broken file shows a clear error', async ({ page }) => {
  await login(page);
  await page.goto('/import');
  await page
    .locator('#midi-file')
    .setInputFiles({ name: 'fake.mid', mimeType: 'audio/midi', buffer: Buffer.from('not midi at all') });
  await expect(page.getByText('This is not a MIDI file')).toBeVisible();
});
