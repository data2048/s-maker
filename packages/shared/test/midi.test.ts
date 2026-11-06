import { describe, expect, it } from 'vitest';
import {
  analyzeMidi,
  briefFromMidi,
  classifyMidi,
  convertEssence,
  detectForm,
  convertFaithful,
  detectKey,
  drumSoundForKey,
  gmSoundForProgram,
  MidiError,
  noteName,
  parseMidi,
  parseTracks,
  validateStrudelCode,
  writeMidi,
  type WriteSpec,
} from '../src';

const Q = 480; // ticks per quarter
const BAR = Q * 4;

const midi = (spec: WriteSpec) => parseMidi(writeMidi(spec));

describe('parseMidi', () => {
  it('reads tracks, notes, tempo, meter and key from a written file', () => {
    const file = midi({
      bpm: 96,
      timeSignature: [3, 4],
      key: { sf: -1, minor: true },
      tracks: [
        {
          name: 'Lead',
          program: 73,
          notes: [
            { tick: 0, duration: Q, pitch: 62, velocity: 90 },
            { tick: Q, duration: Q / 2, pitch: 65 },
          ],
        },
        { name: 'Kit', channel: 9, notes: [{ tick: 0, duration: 10, pitch: 36 }] },
      ],
    });
    expect(file.format).toBe(1);
    expect(file.ppq).toBe(Q);
    expect(file.tempos[0]!.bpm).toBeCloseTo(96, 1);
    expect(file.timeSignatures[0]).toMatchObject({ numerator: 3, denominator: 4 });
    expect(file.keySignatures[0]).toMatchObject({ sf: -1, minor: true });
    // conductor track + 2
    expect(file.tracks).toHaveLength(3);
    const lead = file.tracks[1]!;
    expect(lead.name).toBe('Lead');
    expect(lead.programs[0]).toMatchObject({ channel: 0, program: 73 });
    expect(lead.notes).toEqual([
      { tick: 0, duration: Q, pitch: 62, velocity: 90, channel: 0 },
      { tick: Q, duration: Q / 2, pitch: 65, velocity: 100, channel: 0 },
    ]);
    expect(file.tracks[2]!.notes[0]!.channel).toBe(9);
  });

  it('handles running status, note-on with velocity 0 and unclosed notes', () => {
    // prettier-ignore
    const track = [
      0x00, 0x90, 60, 100,  // note on c4
      0x60, 64, 80,         // running status: note on e4 (delta 96)
      0x60, 60, 0,          // running status: note on vel 0 = note off c4 (delta 96)
      0x00, 0xff, 0x2f, 0,  // end of track: e4 never released
    ];
    const bytes = Uint8Array.from([
      ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96],
      ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length],
      ...track,
    ]);
    const file = parseMidi(bytes);
    expect(file.format).toBe(0);
    expect(file.tracks[0]!.notes).toEqual([
      { tick: 0, duration: 192, pitch: 60, velocity: 100, channel: 0 },
      { tick: 96, duration: 96, pitch: 64, velocity: 80, channel: 0 },
    ]);
  });

  it('cleans control characters from names', () => {
    const file = midi({
      tracks: [{ name: 'Bad\u0007\nname', notes: [{ tick: 0, duration: 1, pitch: 60 }] }],
    });
    expect(file.tracks[1]!.name).toBe('Bad name');
  });

  it.each([
    ['not a MIDI file', new TextEncoder().encode('hello world, this is text')],
    ['truncated', writeMidi({ tracks: [{ notes: [{ tick: 0, duration: 10, pitch: 60 }] }] }).slice(0, 30)],
    ['format 2', Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 2, 0, 1, 0, 96])],
    ['SMPTE timing', Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0xe7, 0x28])],
    ['no tracks', Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96])],
    [
      'bad variable-length number',
      Uint8Array.from([
        ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96],
        ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 6, 0xff, 0xff, 0xff, 0xff, 0x7f, 0],
      ]),
    ],
    [
      'running status without status',
      Uint8Array.from([
        ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96],
        ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 3, 0, 60, 100],
      ]),
    ],
  ])('rejects %s', (_name, bytes) => {
    expect(() => parseMidi(bytes)).toThrow(MidiError);
  });

  it('rejects files over 2 MB', () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set([0x4d, 0x54, 0x68, 0x64]);
    expect(() => parseMidi(big)).toThrow(/too large/);
  });
});

describe('General MIDI mapping', () => {
  it.each([
    [0, 'gm_piano'],
    [3, 'gm_piano'],
    [4, 'gm_epiano1'],
    [23, 'gm_bandoneon'],
    [33, 'gm_electric_bass_finger'],
    [40, 'gm_violin'],
    [56, 'gm_trumpet'],
    [73, 'gm_flute'],
    [81, 'gm_lead_2_sawtooth'],
    [127, 'gm_gunshot'],
  ])('program %i -> %s', (program, sound) => {
    expect(gmSoundForProgram(program)).toBe(sound);
  });

  it('maps GM drum keys', () => {
    expect(drumSoundForKey(36)).toEqual({ sound: 'bd', exact: true });
    expect(drumSoundForKey(38).sound).toBe('sd');
    expect(drumSoundForKey(42).sound).toBe('hh');
    expect(drumSoundForKey(46).sound).toBe('oh');
    expect(drumSoundForKey(56)).toEqual({ sound: 'rim', exact: false });
  });
});

describe('analyzeMidi', () => {
  const scale = (root: number, steps: number[]) =>
    steps.map((s, i) => ({ tick: i * Q, duration: Q, pitch: root + s }));

  it('detects keys from notes', () => {
    const cMajor = [0, 2, 4, 5, 7, 9, 11, 12, 7, 4, 0, 7, 0].map((s, i) => ({
      pitch: 60 + s,
      duration: i % 3 ? 1 : 3,
    }));
    expect(detectKey(cMajor)).toMatchObject({ tonic: 'C', mode: 'major' });
    const aMinor = [0, 2, 3, 5, 7, 8, 11, 12, 7, 3, 0, 0, 7].map((s) => ({ pitch: 57 + s, duration: 1 }));
    expect(detectKey(aMinor)).toMatchObject({ tonic: 'A', mode: 'minor' });
  });

  it('describes parts, splitting tracks by channel', () => {
    const file = parseMidi(
      Uint8Array.from([
        ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0],
        ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 25],
        ...[0, 0xc1, 32], // program 32 (acoustic bass) on channel 2
        ...[0, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0], // c4 on ch1, 480 ticks
        ...[0, 0x91, 36, 90, 0x83, 0x60, 0x81, 36, 0], // c2 on ch2
        ...[0, 0xff, 0x2f, 0],
      ]),
    );
    const a = analyzeMidi(file);
    expect(a.format).toBe(0);
    expect(a.bpm).toBe(120);
    expect(a.parts).toHaveLength(2);
    expect(a.parts[0]).toMatchObject({ channel: 0, sound: 'gm_piano', name: 'Acoustic grand piano ch1' });
    expect(a.parts[1]).toMatchObject({
      channel: 1,
      program: 32,
      sound: 'gm_acoustic_bass',
      low: 36,
      high: 36,
    });
  });

  it('reports bars, duration, ranges, polyphony and drums', () => {
    const file = midi({
      bpm: 120,
      key: { sf: 2, minor: false },
      tracks: [
        { name: 'Keys', notes: [...scale(60, [0, 4, 7]), { tick: 0, duration: BAR, pitch: 48 }] },
        { name: 'Drums', channel: 9, notes: [{ tick: BAR * 2, duration: 10, pitch: 36 }] },
      ],
    });
    const a = analyzeMidi(file);
    expect(a.bars).toBe(3);
    expect(a.durationSeconds).toBe(4);
    expect(a.key).toMatchObject({ tonic: 'D', mode: 'major', source: 'file' });
    expect(a.parts[0]).toMatchObject({ name: 'Keys', low: 48, high: 67, maxPolyphony: 2, noteCount: 4 });
    expect(a.parts[1]).toMatchObject({ isDrums: true, sound: 'drums', firstBar: 2, lastBar: 2 });
  });
});

// ---------------------------------------------------------------------------------------------
// Round trip: evaluate the generated Strudel code with Strudel itself and compare the notes.

async function strudel() {
  const core = await import('@strudel/core');
  const mini = await import('@strudel/mini');
  const { evaluate } = await import('@strudel/transpiler');
  await core.evalScope(core, mini);
  return { evaluate, noteToMidi: core.noteToMidi as (n: string) => number };
}

interface Played {
  bar: number;
  /** Position in the bar, 0..1 */
  at: number;
  len: number;
  pitch: number | string;
  velocity?: number;
}

async function play(code: string, bars: number): Promise<Record<string, Played[]>> {
  const { evaluate, noteToMidi } = await strudel();
  const parsed = parseTracks(code);
  if (!parsed.ok) throw new Error(parsed.error);
  const out: Record<string, Played[]> = {};
  for (const t of parsed.tracks) {
    const { pattern } = (await evaluate(t.body)) as {
      pattern: { queryArc(a: number, b: number): Hap[] };
    };
    out[t.name] = pattern
      .queryArc(0, bars)
      .filter((h) => h.whole.begin.valueOf() === h.part.begin.valueOf())
      .map((h) => {
        const begin = h.whole.begin.valueOf();
        const v = h.value;
        return {
          bar: Math.floor(begin + 1e-9),
          at: round(begin - Math.floor(begin + 1e-9)),
          len: round(h.whole.end.valueOf() - begin),
          pitch: v.note !== undefined ? (typeof v.note === 'number' ? v.note : noteToMidi(v.note)) : v.s!,
          ...(v.velocity !== undefined ? { velocity: v.velocity } : {}),
        };
      })
      .sort(byTime);
  }
  return out;
}

interface Hap {
  whole: { begin: { valueOf(): number }; end: { valueOf(): number } };
  part: { begin: { valueOf(): number } };
  value: { note?: string | number; s?: string; velocity?: number };
}
const round = (x: number) => Math.round(x * 1e6) / 1e6;
const byTime = (a: Played, b: Played) =>
  a.bar - b.bar || a.at - b.at || String(a.pitch).localeCompare(String(b.pitch), 'en', { numeric: true });

/** Seeded pseudo-random generator, so the fixture is the same on every run. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe('convertFaithful', () => {
  it('writes a readable pattern for a simple melody', () => {
    const file = midi({
      bpm: 100,
      tracks: [
        {
          name: 'Flute',
          program: 73,
          notes: [
            { tick: 0, duration: Q, pitch: 60, velocity: 100 },
            { tick: Q, duration: Q, pitch: 64, velocity: 100 },
            { tick: 2 * Q, duration: 2 * Q, pitch: 67, velocity: 100 },
            { tick: BAR, duration: BAR, pitch: 72, velocity: 100 },
          ],
        },
      ],
    });
    const r = convertFaithful(file, { fileName: 'tune.mid' });
    expect(r.grid).toBe(2);
    expect(r.code).toBe(
      [
        '// Imported from MIDI "tune.mid": bars 1-2, 1/8 grid, 4/4',
        'setcpm(100/4)',
        '',
        'flute: note("<[c4 e4 g4@2] c5>").s("gm_flute").velocity(.79)',
        '',
      ].join('\n'),
    );
    expect(validateStrudelCode(r.code, 'strict').ok).toBe(true);
    expect(parseTracks(r.code).tracks[0]).toMatchObject({ name: 'flute', instrument: 'gm_flute' });
  });

  it('writes chords, rests, voices, repeated bars and other meters', () => {
    const file = midi({
      bpm: 90,
      timeSignature: [3, 4],
      key: { sf: -3, minor: false },
      tracks: [
        {
          name: 'Piano',
          notes: [
            // bar 1: Eb major chord on beat 1 (2 beats), rest; melody over it
            ...[63, 67, 70].map((pitch) => ({ tick: 0, duration: 2 * Q, pitch })),
            { tick: 0, duration: 3 * Q, pitch: 75 },
            // bars 2-3 empty, bar 4 like bar 1
            ...[63, 67, 70].map((pitch) => ({ tick: 3 * 3 * Q, duration: 2 * Q, pitch })),
            { tick: 3 * 3 * Q, duration: 3 * Q, pitch: 75 },
          ],
        },
      ],
    });
    const r = convertFaithful(file);
    expect(r.bars).toBe(4);
    expect(r.code).toContain('setcpm(90/3)');
    // two voices layered with ",", flats in Eb major, empty bars compressed with !
    expect(r.code).toContain('piano: note("<eb5 ~!2 eb5>, <[[eb4,g4,bb4]@2 ~] ~!2 [[eb4,g4,bb4]@2 ~]>")');
  });

  it('writes drums as one layer per sound on a drum machine', () => {
    const hits: WriteSpec['tracks'][number]['notes'] = [];
    for (let i = 0; i < 8; i++) hits.push({ tick: (i * Q) / 2, duration: 30, pitch: 42 });
    hits.push({ tick: 0, duration: 30, pitch: 36 }, { tick: 2 * Q, duration: 30, pitch: 36 });
    hits.push({ tick: Q, duration: 30, pitch: 38 }, { tick: 3 * Q, duration: 30, pitch: 38 });
    const file = midi({
      tracks: [{ name: 'Drums', channel: 9, notes: hits.map((h) => ({ ...h, velocity: 100 })) }],
    });
    const r = convertFaithful(file);
    expect(r.code).toContain('drums: s("bd*2, [~ sd]*2, hh*8").bank("RolandTR909").velocity(.79)');
    expect(parseTracks(r.code).tracks[0]).toMatchObject({
      name: 'drums',
      bank: 'RolandTR909',
      instrument: null,
    });
  });

  it('keeps dynamics as velocity patterns aligned with the notes', async () => {
    const file = midi({
      tracks: [
        {
          name: 'Bass',
          program: 33,
          notes: [
            { tick: 0, duration: Q, pitch: 36, velocity: 120 },
            { tick: Q, duration: Q, pitch: 36, velocity: 40 },
            { tick: 2 * Q, duration: Q, pitch: 43, velocity: 80 },
            { tick: BAR, duration: Q, pitch: 36, velocity: 120 },
          ],
        },
      ],
    });
    const r = convertFaithful(file);
    expect(r.code).toContain('.velocity(');
    const played = await play(r.code, r.bars);
    expect(played.bass!.map((p) => [p.bar, p.at, p.pitch, p.velocity])).toEqual([
      [0, 0, 36, 0.94],
      [0, 0.25, 36, 0.31],
      [0, 0.5, 43, 0.63],
      [1, 0, 36, 0.94],
    ]);
    // without velocity
    expect(convertFaithful(file, { velocity: false }).code).not.toContain('velocity');
  });

  it('detects triplets and finer grids', () => {
    const triplets = midi({
      tracks: [
        { notes: [0, 1, 2, 3, 4, 5].map((i) => ({ tick: (i * Q) / 3, duration: Q / 3, pitch: 60 + i })) },
      ],
    });
    expect(convertFaithful(triplets).grid).toBe(3);
    const sixteenths = midi({
      tracks: [{ notes: [0, 1, 2].map((i) => ({ tick: (i * Q) / 4, duration: Q / 4, pitch: 60 })) }],
    });
    expect(convertFaithful(sixteenths).grid).toBe(4);
    // An explicit grid wins.
    expect(convertFaithful(sixteenths, { grid: 8 }).grid).toBe(8);
  });

  it('imports a bar range and only the chosen parts', () => {
    const file = midi({
      tracks: [
        { name: 'A', notes: [0, 1, 2, 3].map((b) => ({ tick: b * BAR, duration: Q, pitch: 60 + b })) },
        { name: 'B', notes: [{ tick: 0, duration: Q, pitch: 40 }] },
      ],
    });
    const r = convertFaithful(file, { parts: [0], startBar: 1, bars: 2 });
    expect(r.startBar).toBe(1);
    expect(r.bars).toBe(2);
    expect(r.code).toContain('bars 2-3');
    expect(r.code).toContain('a: note("<[c#4 ~@3] [d4 ~@3]>")');
    expect(r.code).not.toContain('b:');
    expect(() => convertFaithful(file, { parts: [99] })).toThrow(MidiError);
    expect(() => convertFaithful(file, { parts: [1], startBar: 2 })).toThrow(/no notes/);
  });

  it('warns about shortened notes, tempo changes and approximated drums', () => {
    const bytes = writeMidi({
      tracks: [
        { notes: [{ tick: 0, duration: BAR * 2, pitch: 60 }] },
        { channel: 9, notes: [{ tick: 0, duration: 10, pitch: 56 }] },
      ],
    });
    const file = parseMidi(bytes);
    file.tempos.push({ tick: BAR, bpm: 140 });
    const r = convertFaithful(file);
    expect(r.warnings.join('\n')).toMatch(/shortened/);
    expect(r.warnings.join('\n')).toMatch(/changes tempo/);
    expect(r.warnings.join('\n')).toMatch(/cowbell/);
  });

  it('gives unique labels and safe header text', () => {
    const file = midi({
      tracks: [
        { name: 'Piano', notes: [{ tick: 0, duration: Q, pitch: 60 }] },
        { name: 'Piano', notes: [{ tick: 0, duration: Q, pitch: 64 }] },
      ],
    });
    const r = convertFaithful(file, { fileName: 'evil\n*/ fetch("x").mid' });
    expect(parseTracks(r.code).tracks.map((t) => t.name)).toEqual(['piano', 'piano_2']);
    expect(r.code.split('\n')[0]).toBe('// Imported from MIDI "evil fetch(x).mid": bars 1-1, 1/8 grid, 4/4');
    expect(validateStrudelCode(r.code, 'strict').ok).toBe(true);
  });

  it('spells note names for Strudel', () => {
    expect(noteName(60)).toBe('c4');
    expect(noteName(61)).toBe('c#4');
    expect(noteName(61, true)).toBe('db4');
    expect(noteName(21)).toBe('a0');
    expect(noteName(5)).toBe('5');
  });

  it('round trip: Strudel plays exactly the quantized notes of a dense multi-track file', async () => {
    const rand = rng(42);
    const step = Q / 4; // 1/16
    const melody: WriteSpec['tracks'][number]['notes'] = [];
    const chords: WriteSpec['tracks'][number]['notes'] = [];
    const drums: WriteSpec['tracks'][number]['notes'] = [];
    for (let bar = 0; bar < 8; bar++) {
      // melody: random 16th-grid notes, no overlaps, never across the bar line
      let pos = 0;
      while (pos < 16) {
        const len = 1 + Math.floor(rand() * 4);
        if (pos + len > 16) break;
        if (rand() > 0.25)
          melody.push({
            tick: bar * BAR + pos * step,
            duration: len * step,
            pitch: 60 + Math.floor(rand() * 24),
            velocity: 100,
          });
        pos += len;
      }
      // chords: two half-note chords per bar, plus an overlapping long bass note
      for (const half of [0, 1])
        for (const p of [48, 52, 55].map((x) => x + (bar % 3)))
          chords.push({ tick: bar * BAR + half * 2 * Q, duration: 2 * Q, pitch: p, velocity: 70 });
      chords.push({ tick: bar * BAR + Q, duration: 3 * Q, pitch: 36 + bar, velocity: 70 });
      // drums
      for (let s = 0; s < 16; s++) {
        if (s % 4 === 0) drums.push({ tick: bar * BAR + s * step, duration: 20, pitch: 36, velocity: 100 });
        if (s % 8 === 4) drums.push({ tick: bar * BAR + s * step, duration: 20, pitch: 38, velocity: 100 });
        if (rand() > 0.5) drums.push({ tick: bar * BAR + s * step, duration: 20, pitch: 42, velocity: 100 });
      }
    }
    const file = midi({
      bpm: 128,
      tracks: [
        { name: 'Lead', program: 81, notes: melody },
        { name: 'Pad', program: 89, notes: chords },
        { name: 'Drums', channel: 9, notes: drums },
      ],
    });
    const r = convertFaithful(file, { grid: 4 });
    expect(validateStrudelCode(r.code, 'strict').ok).toBe(true);
    expect(r.warnings).toEqual([]);
    const played = await play(r.code, 8);

    const expected = (notes: typeof melody, drum = false) =>
      notes
        .map((n) => ({
          bar: Math.floor(n.tick / BAR),
          at: round((n.tick % BAR) / BAR),
          len: drum ? 0 : round(n.duration / BAR),
          pitch: drum ? drumSoundForKey(n.pitch).sound : n.pitch,
        }))
        .sort(byTime);
    const strip = (ps: Played[], drum = false) =>
      ps.map(({ bar, at, len, pitch }) => ({ bar, at, len: drum ? 0 : len, pitch }));

    expect(strip(played.lead!)).toEqual(expected(melody));
    expect(strip(played.pad!)).toEqual(expected(chords));
    expect(strip(played.drums!, true)).toEqual(expected(drums, true));
  });
  it('round trip: overlapping voices with their own dynamics (stack + aligned velocity patterns)', async () => {
    const rand = rng(7);
    const notes: WriteSpec['tracks'][number]['notes'] = [];
    for (let bar = 0; bar < 6; bar++) {
      // bars 2-3 repeat bar 1 exactly (compressed with !), the rest is random
      const src = bar >= 1 && bar <= 2 ? 0 : bar;
      const r2 = rng(100 + src);
      for (let beat = 0; beat < 4; beat++) {
        notes.push({
          tick: bar * BAR + beat * Q,
          duration: Q / 2,
          pitch: 72 + Math.floor(r2() * 5),
          velocity: 30 + Math.floor(r2() * 90),
        });
      }
      notes.push({ tick: bar * BAR, duration: 3 * Q, pitch: 48, velocity: 40 + Math.floor(rand() * 80) });
    }
    const file = midi({ tracks: [{ name: 'Keys', notes }] });
    const r = convertFaithful(file, { grid: 4 });
    expect(r.code).toContain('keys: stack(');
    expect(r.code).toMatch(/]!3 /);
    expect(validateStrudelCode(r.code, 'strict').ok).toBe(true);
    const played = await play(r.code, 6);
    const expected = notes
      .map((n) => ({
        bar: Math.floor(n.tick / BAR),
        at: round((n.tick % BAR) / BAR),
        len: round(n.duration / BAR),
        pitch: n.pitch,
        velocity: Math.round((n.velocity! / 127) * 100) / 100,
      }))
      .sort(byTime);
    expect(played.keys).toEqual(expected);
  });
});

// Evaluates a track with the song's const declarations in front of it.
async function playEssence(code: string, bars: number): Promise<Record<string, Played[]>> {
  const { evaluate, noteToMidi } = await strudel();
  const parsed = parseTracks(code);
  if (!parsed.ok) throw new Error(parsed.error);
  const consts = code
    .split('\n')
    .filter((l) => l.startsWith('const '))
    .join('\n');
  const out: Record<string, Played[]> = {};
  for (const t of parsed.tracks) {
    const { pattern } = (await evaluate(`${consts}\n${t.body}`)) as {
      pattern: { queryArc(a: number, b: number): Hap[] };
    };
    out[t.name] = pattern
      .queryArc(0, bars)
      .filter((h) => h.whole.begin.valueOf() === h.part.begin.valueOf())
      .map((h) => {
        const begin = h.whole.begin.valueOf();
        const v = h.value;
        return {
          bar: Math.floor(begin + 1e-9),
          at: round(begin - Math.floor(begin + 1e-9)),
          len: round(h.whole.end.valueOf() - begin),
          pitch: v.note !== undefined ? (typeof v.note === 'number' ? v.note : noteToMidi(v.note)) : v.s!,
        };
      })
      .sort(byTime);
  }
  return out;
}

describe('detectForm', () => {
  const bar = (...x: string[]) => new Set(x);
  it('finds AABA from whole blocks', () => {
    const A = [bar('a1'), bar('a2'), bar('a3'), bar('a4')];
    const B = [bar('b1'), bar('b2'), bar('b3'), bar('b4')];
    const f = detectForm([...A, ...A, ...B, ...A]);
    expect(f.blockBars).toBe(4);
    expect(f.sections.map((s) => [s.label, s.bars])).toEqual([
      ['A', 8],
      ['B', 4],
      ['A', 4],
    ]);
  });
  it('treats one repeating bar as one section', () => {
    const f = detectForm(Array.from({ length: 16 }, () => bar('x', 'y')));
    expect(f.blockBars).toBe(1);
    expect(f.sections).toEqual([{ label: 'A', startBar: 0, bars: 16 }]);
  });
  it('tolerates small variations within a section', () => {
    const f = detectForm([bar('a', 'b', 'c', 'd', 'e'), bar('a', 'b', 'c', 'd', 'e', 'f'), bar('z')]);
    expect(f.sections.map((s) => s.label)).toEqual(['A', 'B']);
  });
});

describe('convertEssence', () => {
  const phrase = (bar: number, pitches: number[]) =>
    pitches.map((pitch, i) => ({ tick: bar * BAR + i * Q, duration: Q, pitch, velocity: 90 }));
  const A = (bar: number) => [...phrase(bar, [60, 62, 64, 65]), ...phrase(bar + 1, [67, 65, 64, 62])];
  const B = (bar: number) => [...phrase(bar, [72, 71, 69, 67]), ...phrase(bar + 1, [69, 71, 72, 74])];
  const song = [...A(0), ...A(2), ...B(4), ...A(6)];
  const kick = Array.from({ length: 32 }, (_, i) => ({
    tick: i * Q,
    duration: 20,
    pitch: 36,
    velocity: 100,
  }));
  const file = () =>
    midi({
      bpm: 120,
      tracks: [
        { name: 'Lead', program: 73, notes: song },
        { name: 'Drums', channel: 9, notes: kick },
      ],
    });

  it('writes sections with arrange and valid code', () => {
    const r = convertEssence(file());
    expect(r.form.map((s) => [s.label, s.bars])).toEqual([
      ['A', 4],
      ['B', 2],
      ['A', 2],
    ]);
    expect(r.code).toContain('// Form: A (4) B (2) A (2)');
    expect(r.code).toContain('const lead_a = ');
    expect(r.code).toContain('lead: arrange([4, lead_a], [2, lead_b], [2, lead_a]).s("gm_flute")');
    expect(validateStrudelCode(r.code, 'strict').ok).toBe(true);
    const tracks = parseTracks(r.code).tracks;
    expect(tracks.map((t) => t.name)).toEqual(['lead', 'drums']);
    expect(tracks[0]!.instrument).toBe('gm_flute');
    expect(tracks[1]!.bank).toBe('RolandTR909');
  });

  it('round trip: an exactly repeating form plays every note', async () => {
    const r = convertEssence(file());
    const played = await playEssence(r.code, 8);
    const expected = song
      .map((n) => ({
        bar: Math.floor(n.tick / BAR),
        at: round((n.tick % BAR) / BAR),
        len: round(n.duration / BAR),
        pitch: n.pitch,
      }))
      .sort(byTime);
    expect(played.lead).toEqual(expected);
    expect(played.drums!.map((p) => p.pitch)).toEqual(new Array(32).fill('bd'));
  });

  it('keeps the dominant version of a bar and is shorter than faithful on repetitive music', async () => {
    const notes = [];
    for (let i = 0; i < 16; i++) notes.push(...phrase(i, [60, 64, 67, 72]));
    // A fill in bar 10 is dropped.
    const noisy = notes.filter((n) => !(n.tick === 10 * BAR + Q));
    noisy.push({ tick: 10 * BAR + Q, duration: Q, pitch: 61, velocity: 90 });
    const f = midi({ tracks: [{ name: 'Keys', notes: noisy }] });
    const r = convertEssence(f);
    expect(r.form).toEqual([{ label: 'A', startBar: 0, bars: 16 }]);
    expect(r.code).toContain('keys: note("[c4 e4 g4 c5]")');
    expect(r.code.length).toBeLessThan(convertFaithful(f).code.length);
    const played = await playEssence(r.code, 16);
    expect(played.keys!.filter((p) => p.pitch === 61)).toEqual([]);
    expect(played.keys).toHaveLength(64);
  });

  it('reduces thick parts to 3 voices', () => {
    const cluster = [48, 55, 60, 64, 67, 72].map((pitch, i) => ({ tick: 0, duration: BAR - i * 100, pitch }));
    const r = convertEssence(midi({ tracks: [{ name: 'Pad', notes: cluster }] }), { grid: 8 });
    expect(r.stats.droppedNotes).toBeGreaterThan(0);
    const line = r.code.split('\n').find((l) => l.startsWith('pad:'))!;
    expect((line.match(/, /g) ?? []).length).toBeLessThanOrEqual(2);
  });
});

describe('classifyMidi', () => {
  const part = (program: number, isDrums = false) => ({ program, isDrums }) as never;
  it.each([
    [[part(0)], 'solo_piano'],
    [[part(0), part(1)], 'solo_piano'],
    [[part(0, true), part(33), part(29), part(30)], 'band'],
    [[part(40), part(41), part(42), part(60), part(73)], 'orchestral'],
    [[part(0, true), part(38), part(81), part(90)], 'electronic'],
    [[part(0, true), part(32), part(65), part(0)], 'jazz'],
    [[part(80), part(81), part(80)], 'chiptune'],
    [[part(120)], 'other'],
  ])('classifies %#', (parts, type) => {
    const c = classifyMidi({ parts, tempoChanges: 0 });
    expect(c.type).toBe(type);
    expect(c.reasons.length).toBeGreaterThan(0);
  });
  it('is included in the analysis', () => {
    const a = analyzeMidi(midi({ tracks: [{ program: 0, notes: [{ tick: 0, duration: Q, pitch: 60 }] }] }));
    expect(a.classification.type).toBe('solo_piano');
  });
});

describe('briefFromMidi', () => {
  it('fills the elements it can read from the file', () => {
    const notes = [60, 62, 64, 65, 67, 69, 71, 72].map((pitch, i) => ({
      tick: i * Q,
      duration: Q / 2,
      pitch,
      velocity: i % 4 === 0 ? 120 : 70,
    }));
    const b = briefFromMidi(
      midi({
        bpm: 90,
        timeSignature: [4, 4],
        key: { sf: 0, minor: true },
        tracks: [{ name: 'Flute', program: 73, notes }],
      }),
      { form: [{ label: 'A', startBar: 0, bars: 2 }], type: 'other' },
    );
    expect(b).toMatchObject({
      meter: '4/4',
      tempo: '90 BPM',
      key: 'A minor',
      articulation: 'Mostly staccato',
      timbre: 'Flute',
      form: 'A (2)',
      style: 'Other',
      accentuation: 'First beat of the bar is stressed',
    });
    expect(b.melody).toContain('c4–c5');
    expect(b.melody).toContain('stepwise');
    expect(b.texture).toBe('One line');
    expect(b.dynamics).toContain('mp to ff');
  });
});
