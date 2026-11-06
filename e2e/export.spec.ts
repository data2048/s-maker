import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { login, playerFrame, playerReady } from './helpers';

test.describe.configure({ mode: 'serial' });

// Synths only: they need no downloads, so this does not depend on the network.
const SONG = `setcpm(120/4)

lead: note("c4 e4 g4 b4").s("sawtooth").gain(.6)

bass: note("c2 g2").s("square").gain(.5)

_muted: note("c6*16").s("sine")
`;

async function exportFile(page: Page, format: 'mp3' | 'wav' | 'midi', label: string) {
  await page.getByLabel('Format').selectOption(format);
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: label, exact: true }).click();
  const file = await download;
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

/** How loud the samples of a 16-bit WAV are, from silence (0) to full scale (1). */
function wavLevel(bytes: Buffer): number {
  let sum = 0;
  let count = 0;
  for (let i = 44; i + 1 < bytes.length; i += 2) {
    const s = bytes.readInt16LE(i) / 32768;
    sum += s * s;
    count++;
  }
  return Math.sqrt(sum / count);
}

test('export to WAV, MP3 and MIDI, then keep playing', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'New song' }).click();
  await expect(page).toHaveURL(/\/songs\/\d+$/);
  await playerReady(page);
  const player = playerFrame(page);
  await page.waitForFunction(() => document.querySelector('iframe'));
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  // Put the song in the editor the way an edit from the app does.
  await player.locator('.cm-content').click();
  await player.locator('.cm-content').press('Control+a');
  await player.locator('.cm-content').press('Delete');
  await player.locator('.cm-content').pressSequentially(SONG.replaceAll('\n', ' \n'), { delay: 0 });
  await page.waitForTimeout(600);
  await page.getByLabel('Length in bars').fill('2');

  const wav = await exportFile(page, 'wav', 'Export WAV');
  expect(wav.name).toBe('Untitled-song.wav');
  expect(wav.bytes.subarray(0, 4).toString()).toBe('RIFF');
  // 2 bars at 120 BPM are 4 s, plus 2 s for what keeps sounding: 6 s of 16-bit stereo.
  expect(wav.bytes.length).toBeGreaterThan(5 * 44100 * 4);
  expect(wav.bytes.length).toBeLessThan(7 * 44100 * 4);
  expect(wavLevel(wav.bytes)).toBeGreaterThan(0.01);
  await expect(page.locator('.export-panel .alert.ok')).toContainText('Untitled-song.wav');

  const mp3 = await exportFile(page, 'mp3', 'Export MP3');
  expect(mp3.name).toBe('Untitled-song.mp3');
  expect(mp3.bytes[0]).toBe(0xff);
  expect(mp3.bytes[1]! & 0xe0).toBe(0xe0);
  expect(mp3.bytes.length).toBeLessThan(wav.bytes.length / 4);
  // 6 s at 192 kbps is about 144 KB, so this is not an empty shell.
  expect(mp3.bytes.length).toBeGreaterThan(100_000);

  const midi = await exportFile(page, 'midi', 'Export MIDI');
  expect(midi.name).toBe('Untitled-song.mid');
  expect(midi.bytes.subarray(0, 4).toString()).toBe('MThd');
  await expect(page.locator('.export-panel .alert.ok')).toContainText('Untitled-song.mid');

  // The player must still work: the export replaced its audio engine for a moment.
  await player.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByText('● playing')).toBeVisible({ timeout: 30_000 });
  await expect(player.locator('#error')).toBeHidden();
  await player.getByRole('button', { name: 'Stop' }).click();
});

test('refuses a song longer than the limit, and explains', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'New song' }).click();
  await playerReady(page);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByLabel('Length in bars').fill('1000');
  await page.getByLabel('Format').selectOption('wav');
  await page.getByRole('button', { name: 'Export WAV', exact: true }).click();
  await expect(page.locator('.export-panel .alert.error')).toContainText('The limit is 300 s', {
    timeout: 30_000,
  });
});
