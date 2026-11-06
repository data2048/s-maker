import { describe, expect, it } from 'vitest';
import { diffLines } from '../src/diff';
import {
  addTrack,
  NEW_SONG_CODE,
  parseTracks,
  removeTrack,
  renameTrack,
  sanitizeTrackName,
  setTrackInstrument,
  setTrackMuted,
  setTrackSolo,
} from '../src/strudel/tracks';

const SONG = `setcpm(100/4)

drums: s("bd ~ sd ~, hh*8").bank("RolandTR909")

_bass: note("<c2 a1>").s("gm_acoustic_bass").legato(.9)

Skeys: note("c3 e3").sound('gm_piano').gain(.6)

$: n("0 2 4").scale("C:minor")
`;

const tracks = (code: string) => {
  const r = parseTracks(code);
  if (!r.ok) throw new Error(r.error);
  return r.tracks;
};

describe('parseTracks', () => {
  it('finds labeled patterns with their flags, instrument and bank', () => {
    const t = tracks(SONG);
    expect(t.map((x) => [x.name, x.muted, x.solo, x.instrument, x.bank])).toEqual([
      ['drums', false, false, null, 'RolandTR909'],
      ['bass', true, false, 'gm_acoustic_bass', null],
      ['keys', false, true, 'gm_piano', null],
      ['$', false, false, null, null],
    ]);
    expect(t[1]!.body).toBe('note("<c2 a1>").s("gm_acoustic_bass").legato(.9)');
  });

  it('ignores non-label statements and reports syntax errors', () => {
    expect(tracks('setcpm(1)\nconst x = 1\nx')).toEqual([]);
    const bad = parseTracks('drums: s("bd"');
    expect(bad.ok).toBe(false);
  });

  it('takes the outermost .s() as the instrument', () => {
    expect(tracks('a: note("c").s("gm_piano").s("gm_flute")')[0]!.instrument).toBe('gm_flute');
  });

  it('does not treat a drum pattern as a single instrument', () => {
    expect(tracks('d: s("bd sd")')[0]!.instrument).toBeNull();
  });

  it('parses the new song template', () => {
    expect(tracks(NEW_SONG_CODE).map((t) => t.name)).toEqual(['drums', 'bass', 'keys']);
  });
});

describe('track edits', () => {
  it('mutes and unmutes', () => {
    const muted = setTrackMuted(SONG, 0, true);
    expect(muted).toContain('_drums: s(');
    expect(tracks(muted)[0]!.muted).toBe(true);
    expect(setTrackMuted(SONG, 1, false)).toContain('\nbass: note(');
  });

  it('solos and keeps mute flag', () => {
    const s = setTrackSolo(SONG, 1, true);
    expect(s).toContain('_Sbass:');
    expect(setTrackSolo(SONG, 2, false)).toContain('\nkeys: note(');
  });

  it('replaces an existing instrument, keeping the rest', () => {
    const out = setTrackInstrument(SONG, 1, 'gm_fretless_bass');
    expect(out).toContain('note("<c2 a1>").s("gm_fretless_bass").legato(.9)');
    expect(setTrackInstrument(SONG, 2, 'gm_epiano1')).toContain(`.sound("gm_epiano1")`);
  });

  it('appends an instrument when there is none', () => {
    const out = setTrackInstrument(SONG, 3, 'gm_flute');
    expect(out).toContain('$: n("0 2 4").scale("C:minor").s("gm_flute")');
  });

  it('rejects odd instrument names', () => {
    expect(() => setTrackInstrument(SONG, 0, 'x") + fetch("')).toThrow();
  });

  it('renames with sanitizing and keeps flags', () => {
    expect(renameTrack(SONG, 1, 'Fat Bass!')).toContain('_fat_bass: note(');
    // name already taken -> suffix
    expect(renameTrack(SONG, 0, 'keys')).toContain('keys_2: s(');
  });

  it('removes a track cleanly', () => {
    const out = removeTrack(SONG, 1);
    expect(out).not.toContain('bass');
    expect(out).toContain('RolandTR909")\n\nSkeys');
    expect(tracks(out)).toHaveLength(3);
  });

  it('adds a track with a unique name', () => {
    const out = addTrack(SONG, 'drums', 's("hh*16")');
    expect(out.endsWith('drums_2: s("hh*16")\n')).toBe(true);
    expect(addTrack('', 'lead', 'note("c4")')).toBe('lead: note("c4")\n');
  });

  it('refuses to edit code that does not parse', () => {
    expect(() => setTrackMuted('a: s("bd"', 0, true)).toThrow(/syntax error/);
  });
});

describe('sanitizeTrackName', () => {
  it.each([
    ['Lead Synth', 'lead_synth'],
    ['  ', 'track'],
    ['808', 't808'],
    ['for', 'for_track'],
    ['Żółć bas', 'zolc_bas'],
  ])('%s -> %s', (input, out) => {
    expect(sanitizeTrackName(input)).toBe(out);
  });
});

describe('diffLines', () => {
  it('marks added and removed lines', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(d).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'same', text: 'c' },
      { type: 'add', text: 'd' },
    ]);
  });

  it('handles identical input', () => {
    expect(diffLines('x\ny', 'x\ny').every((l) => l.type === 'same')).toBe(true);
  });
});

describe('setTrackBank', () => {
  it('replaces or appends the drum machine', async () => {
    const { setTrackBank } = await import('../src/strudel/tracks');
    expect(setTrackBank(SONG, 0, 'RolandTR808')).toContain('.bank("RolandTR808")');
    expect(setTrackBank('d: s("bd sd")', 0, 'LinnDrum')).toBe('d: s("bd sd").bank("LinnDrum")');
  });
});
