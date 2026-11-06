// The agent learns Strudel from kb/strudel-cheatsheet.md, so every example there must really work.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GM_SOUNDS, DRUM_BANKS, isValidNote, parseTracks, validateStrudelCode } from '../src';

describe('isValidNote', () => {
  it.each(['c3', 'C3', 'c#4', 'eb4', 'bb2', 'cs3', 'c', 'c-1', 60, 61.5])('accepts %s', (n) => {
    expect(isValidNote(n)).toBe(true);
  });
  it.each(['r3', 'h2', 'maj7', '', '3c', Infinity, null, {}])('refuses %s', (n) => {
    expect(isValidNote(n)).toBe(false);
  });
});

// Git on Windows can check files out with CRLF.
const sheet = readFileSync(join(process.cwd(), 'kb/strudel-cheatsheet.md'), 'utf8').replaceAll('\r\n', '\n');
const blocks = [...sheet.matchAll(/```strudel\n([\s\S]*?)```/g)].map((m) => m[1]!);

async function strudel() {
  const core = await import('@strudel/core');
  const mini = await import('@strudel/mini');
  const tonal = await import('@strudel/tonal');
  const { evaluate } = await import('@strudel/transpiler');
  await core.evalScope(core, mini, tonal);
  (globalThis as Record<string, unknown>).setcpm = () => {};
  return evaluate;
}

describe('Strudel cheat sheet', () => {
  it('has examples', () => {
    expect(blocks.length).toBeGreaterThan(15);
  });

  it.each(blocks.map((b, i) => [i, b] as const))(
    'example %i runs and passes the validator',
    async (_i, code) => {
      expect(validateStrudelCode(code, 'strict').issues.filter((i) => i.severity === 'error')).toEqual([]);
      const evaluate = await strudel();
      const parsed = parseTracks(code);
      if (!parsed.ok) throw new Error(parsed.error);
      const header = parsed.tracks[0] ? code.slice(0, parsed.tracks[0].range[0]) : '';
      const bodies = parsed.tracks.length ? parsed.tracks.map((t) => `${header}\n${t.body}`) : [code];
      for (const body of bodies) {
        const { pattern } = (await evaluate(body)) as {
          pattern: { queryArc(a: number, b: number): unknown[] };
        };
        expect(pattern.queryArc(0, 4).length).toBeGreaterThan(0);
      }
    },
  );

  it('lists exactly the sounds that exist', () => {
    const listed = [...new Set(sheet.match(/\bgm_[a-z0-9_]+\b/g))];
    expect(listed.filter((s) => !(GM_SOUNDS as readonly string[]).includes(s))).toEqual([]);
    for (const s of GM_SOUNDS) expect(sheet).toContain(s);
    for (const b of DRUM_BANKS) expect(sheet).toContain(b);
  });
});
