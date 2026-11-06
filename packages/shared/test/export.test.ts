import { describe, expect, it } from 'vitest';
import {
  beatsPerBar,
  cyclesPerSecond,
  encodeWav,
  estimateBars,
  eventsToMidi,
  exportFileName,
  fromSandboxSchema,
  isExportedAudio,
  midiExportSchema,
  midiExportToSpec,
  noteToMidiNumber,
  parseMidi,
  toSandboxSchema,
  writeMidi,
} from '../src';

describe('song length and tempo', () => {
  it('reads the tempo and the bar from setcpm', () => {
    expect(cyclesPerSecond('setcpm(120/4)')).toBeCloseTo(0.5);
    expect(cyclesPerSecond('setcpm(30)')).toBeCloseTo(0.5);
    expect(cyclesPerSecond('note("c")')).toBeNull();
    expect(beatsPerBar('setcpm(120/3)')).toBe(3);
    expect(beatsPerBar('note("c")')).toBe(4);
  });

  it('takes the longest arrange as the length', () => {
    const code = `setcpm(90/4)
const a = note("c")
drums: arrange([4, a], [8, a], [4, silence])
bass: arrange([8, a])`;
    expect(estimateBars(code)).toBe(16);
  });

  it('falls back to 8 bars', () => {
    expect(estimateBars('lead: note("c d")')).toBe(8);
    expect(estimateBars('this is not ( code')).toBe(8);
  });
});

describe('file names', () => {
  it('keeps them safe', () => {
    expect(exportFileName('My song (v2)', 'mp3')).toBe('My-song-v2.mp3');
    expect(exportFileName('../../etc/passwd', 'wav')).toMatch(/^[\w-]+\.wav$/);
    expect(exportFileName('', 'midi')).toBe('song.mid');
  });
});

describe('audio files', () => {
  it('writes a WAV that says what it holds', () => {
    const left = new Float32Array([0, 1, -1, 0.5]);
    const right = new Float32Array([0, -1, 1, -0.5]);
    const buffer = encodeWav([left, right], 44100);
    expect(buffer.byteLength).toBe(44 + 4 * 2 * 2);
    const view = new DataView(buffer);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getInt16(44 + 4, true)).toBe(32767);
    expect(view.getInt16(44 + 6, true)).toBe(-32768);
    expect(isExportedAudio('wav', buffer)).toBe(true);
  });

  it('refuses anything else offered as audio', () => {
    const html = new TextEncoder().encode('<html><script>alert(1)</script>' + ' '.repeat(50))
      .buffer as ArrayBuffer;
    expect(isExportedAudio('wav', html)).toBe(false);
    expect(isExportedAudio('mp3', html)).toBe(false);
    expect(isExportedAudio('mp3', new ArrayBuffer(0))).toBe(false);
    expect(isExportedAudio('mp3', new Uint8Array([0xff, 0xfb, 0x90, 0x00]).buffer)).toBe(true);
    expect(isExportedAudio('mp3', new TextEncoder().encode('ID3xxx').buffer as ArrayBuffer)).toBe(true);
  });
});

describe('MIDI', () => {
  it('reads note names as Strudel does', () => {
    expect(noteToMidiNumber('c4')).toBe(60);
    expect(noteToMidiNumber('c#4')).toBe(61);
    expect(noteToMidiNumber('eb3')).toBe(51);
    expect(noteToMidiNumber('cs3')).toBe(49);
    expect(noteToMidiNumber('c')).toBe(48);
    expect(noteToMidiNumber(61.4)).toBe(61);
    expect(noteToMidiNumber('r3')).toBeNull();
  });

  const events = eventsToMidi({
    cyclesPerSecond: 0.5,
    beats: 4,
    tracks: [
      {
        name: 'bass',
        events: [
          { begin: 0, end: 0.5, value: { note: 'c2', s: 'gm_acoustic_bass', velocity: 1 } },
          { begin: 0.5, end: 1, value: { note: 'g2', s: 'gm_acoustic_bass' } },
        ],
      },
      {
        name: 'drums',
        events: [
          { begin: 0, end: 0.25, value: { s: 'bd' } },
          { begin: 0.25, end: 0.5, value: { s: 'hh:2' } },
          { begin: 0.5, end: 0.75, value: { s: 'some_sample' } },
        ],
      },
      { name: 'lead', events: [{ begin: 0, end: 1, value: { note: 'c5', s: 'sawtooth' } }] },
    ],
  });

  it('counts what MIDI cannot hold', () => {
    expect(events.skipped).toBe(1);
    expect(events.bpm).toBeCloseTo(120);
  });

  it('survives writing and reading back', () => {
    expect(midiExportSchema.safeParse(events).success).toBe(true);
    const file = parseMidi(writeMidi(midiExportToSpec(events)));
    expect(file.tempos[0]!.bpm).toBeCloseTo(120, 0);
    expect(file.timeSignatures[0]).toMatchObject({ numerator: 4, denominator: 4 });
    const notes = (name: string) => file.tracks.find((t) => t.name === name)!.notes;
    expect(notes('bass').map((n) => [n.tick, n.duration, n.pitch, n.velocity])).toEqual([
      [0, 960, 36, 127],
      [960, 960, 43, 100],
    ]);
    expect(notes('drums').map((n) => [n.pitch, n.channel])).toEqual([
      [36, 9],
      [42, 9],
    ]);
    const bass = file.tracks.find((t) => t.name === 'bass')!;
    // gm_acoustic_bass is General MIDI program 32.
    expect(bass.programs[0]!.program).toBe(32);
    expect(file.tracks.find((t) => t.name === 'lead')!.programs[0]!.program).toBe(81);
  });

  it('never gives a melodic track the drum channel', () => {
    const many = {
      bpm: 120,
      beats: 4,
      skipped: 0,
      tracks: Array.from({ length: 20 }, (_, i) => ({
        name: `t${i}`,
        drums: false,
        program: 0,
        notes: [],
      })),
    };
    for (const t of midiExportToSpec(many).tracks) expect(t.channel).not.toBe(9);
  });

  it('splits a track that plays several instruments', () => {
    const m = eventsToMidi({
      cyclesPerSecond: 0.5,
      beats: 4,
      tracks: [
        {
          name: 'keys',
          events: [
            { begin: 0, end: 1, value: { note: 'c4', s: 'gm_piano' } },
            { begin: 0, end: 1, value: { note: 'e4', s: 'gm_flute' } },
          ],
        },
      ],
    });
    expect(m.tracks.map((t) => t.name)).toEqual(['keys gm_piano', 'keys gm_flute']);
  });
});

describe('messages with the player', () => {
  it('limits what can be asked for', () => {
    const ok = { type: 'export', id: 1, code: 'note("c")', format: 'mp3', bars: 8 };
    expect(toSandboxSchema.safeParse(ok).success).toBe(true);
    expect(toSandboxSchema.safeParse({ ...ok, bars: 0 }).success).toBe(false);
    expect(toSandboxSchema.safeParse({ ...ok, bars: 100000 }).success).toBe(false);
    expect(toSandboxSchema.safeParse({ ...ok, format: 'exe' }).success).toBe(false);
  });

  it('accepts bytes only as real binary data, and checks notes', () => {
    const base = { type: 'exported', id: 1, error: null };
    expect(fromSandboxSchema.safeParse({ ...base, bytes: new ArrayBuffer(4) }).success).toBe(true);
    expect(fromSandboxSchema.safeParse({ ...base, bytes: 'text' }).success).toBe(false);
    const midi = {
      bpm: 120,
      beats: 4,
      skipped: 0,
      tracks: [
        { name: 't', drums: false, program: 0, notes: [{ tick: 0, duration: 1, pitch: 200, velocity: 1 }] },
      ],
    };
    expect(fromSandboxSchema.safeParse({ ...base, midi }).success).toBe(false);
  });
});
