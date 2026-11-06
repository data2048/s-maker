import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_LLM_PORT } from './fake-llm';
import { login, playerReady } from './helpers';

test.describe.configure({ mode: 'serial' });

const HOSTILE = '<img src=x onerror="window.xss=true">';
const REQUEST = `Change the bass, logged ${Date.now()} ${HOSTILE}`;
const folder = mkdtempSync(join(tmpdir(), 's-maker-runs-'));
const file = join(folder, 'marked.json');

/** Runs the script the way a person would, without paying for anything. */
const evalModels = (args: string[]) =>
  spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/eval-models.ts', ...args], {
    encoding: 'utf8',
    timeout: 45_000,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      OPENROUTER_API_KEY: 'e2e-fake',
      OPENROUTER_BASE_URL: `http://127.0.0.1:${FAKE_LLM_PORT}/v1`,
    },
  });

test('a run shows in the panel as text, can be marked, downloaded and replayed', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.getByRole('button', { name: 'New song' }).click();
  await expect(page).toHaveURL(/\/songs\/\d+$/);
  await playerReady(page);
  await expect(page.locator('.agent-privacy').first()).toContainText('even private ones');
  await page.getByLabel('Instruction for the agent').fill(REQUEST);
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await expect(page.locator('.proposal')).toContainText('Changed the bass', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.locator('.proposal')).toBeHidden();

  await page.goto('/admin');
  await page.getByRole('tab', { name: 'agent' }).click();
  const row = page.getByRole('row').filter({ hasText: REQUEST });
  await expect(row).toContainText('accepted');
  await expect(row).toContainText('e2e-admin');
  await expect(row).toContainText('40 thinking');

  // Details: the hostile request is only text.
  await row.getByRole('button', { name: /^Open run/ }).click();
  const details = page.getByRole('region', { name: /^Run \d+$/ });
  await expect(details.locator('pre.log-text').first()).toHaveText(REQUEST);
  await expect(details).toContainText('800 cached');
  await expect(details).toContainText('finish: stop');
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { xss?: boolean }).xss)).toBeUndefined();

  // The system prompt is there once asked for.
  await details.getByRole('button', { name: /Show system prompt/ }).click();
  await expect(details).toContainText('# Strudel reference');

  // Marking and a note survive a reload.
  await row.getByRole('checkbox').check();
  await details.getByLabel('Note on this run').fill('Keep for model tests');
  await details.getByRole('button', { name: 'Save note' }).click();
  await expect(details.getByText('Saved.')).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'agent' }).click();
  await page.getByLabel('Marked only').check();
  await expect(page.getByRole('row').filter({ hasText: REQUEST }).getByRole('checkbox')).toBeChecked();

  // The history of the song reads in order and says who saved what.
  await page
    .getByRole('row')
    .filter({ hasText: REQUEST })
    .getByRole('button', { name: /^History of the song/ })
    .click();
  const history = page.getByRole('region', { name: 'Song history' });
  await expect(history.locator(':scope > .log-event > p')).toHaveText([
    /v1 · saved by hand/,
    /Run \d+ .*accepted/,
    /v2 · saved from the agent/,
  ]);
  await expect(history.locator('.diff').first()).toContainText('gm_synth_bass_1');
  await page.screenshot({ path: 'test-results/agent-runs.png', fullPage: true });

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download marked runs' }).click();
  await (await download).saveAs(file);
  const text = readFileSync(file, 'utf8');
  expect(text).not.toContain('e2e-admin');
  expect(text).toContain('Keep for model tests');

  const list = evalModels(['--from', file, '--list']);
  expect(list.status, list.stderr).toBe(0);
  expect(list.stdout).toContain('Change the bass, logged');
  expect(list.stdout).toContain('1 requests');

  const out = join(folder, 'replay.json');
  const replay = evalModels(['--from', file, '--out', out, 'fake/replay-model']);
  expect(replay.status, replay.stderr).toBe(0);
  const [result] = JSON.parse(readFileSync(out, 'utf8')) as {
    model: string;
    ok: boolean;
    code: string;
    original: { decision: string };
  }[];
  expect(result).toMatchObject({ model: 'fake/replay-model', ok: true, original: { decision: 'accepted' } });
  expect(result!.code).toContain('gm_synth_bass_1');
});
