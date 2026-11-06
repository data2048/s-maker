// Exporting a song to a file. The player works out the sound and the notes, the app checks them and saves the file.
import { parse, type Node } from 'acorn';
import { z } from 'zod';
import { DRUM_SOUNDS } from '../midi/gm';
import { safeFileName } from '../midi/faithful';
import type { WriteSpec } from '../midi/write';
import { GM_SOUNDS } from './instruments';

export const EXPORT_FORMATS = ['mp3', 'wav', 'midi'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const DEFAULT_EXPORT_BARS = 8;
export const MAX_EXPORT_BARS = 1024;
/** Longer renders run out of memory on phones. */
export const MAX_EXPORT_SECONDS = 300;
/** Five minutes of 16-bit stereo WAV is about 53 MB; this leaves room and still stops abuse. */
export const MAX_EXPORT_BYTES = 200 * 1024 * 1024;
const MAX_MIDI_NOTES = 200_000;

export const EXPORT_PPQ = 480;

/** The tempo from setcpm(bpm/beats), in cycles per second, if the code says so plainly. */
export function cyclesPerSecond(code: string): number | null {
  const m = /setcpm\(\s*([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)/.exec(code);
  if (!m) return null;
  const cpm = Number(m[1]) / (m[2] ? Number(m[2]) : 1);
  return cpm > 0 ? cpm / 60 : null;
}

/** Beats in a bar from setcpm(bpm/beats). One cycle is one bar. */
export function beatsPerBar(code: string): number {
  const m = /setcpm\(\s*[\d.]+\s*\/\s*(\d+)\s*\)/.exec(code);
  const beats = m ? Number(m[1]) : 4;
  return beats >= 1 && beats <= 32 ? beats : 4;
}

function visit(node: unknown, fn: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) visit(item, fn);
    return;
  }
  if (!node || typeof (node as Node).type !== 'string') return;
  fn(node as Node);
  for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value, fn);
}

/**
 * A song plays in a loop, so it has no length of its own. The longest arrange(...) is the best guess.
 */
export function estimateBars(code: string): number {
  let longest = 0;
  try {
    visit(parse(code, { ecmaVersion: 'latest', sourceType: 'script' }), (n) => {
      const call = n as unknown as {
        type: string;
        callee?: { name?: string };
        arguments?: { type: string; elements?: { type: string; value?: unknown }[] }[];
      };
      if (call.type !== 'CallExpression' || call.callee?.name !== 'arrange') return;
      let total = 0;
      for (const arg of call.arguments ?? []) {
        const first = arg.type === 'ArrayExpression' ? arg.elements?.[0] : undefined;
        if (first?.type === 'Literal' && typeof first.value === 'number') total += first.value;
      }
      longest = Math.max(longest, total);
    });
  } catch {
    return DEFAULT_EXPORT_BARS;
  }
  return longest >= 1 ? Math.min(Math.ceil(longest), MAX_EXPORT_BARS) : DEFAULT_EXPORT_BARS;
}

export function exportFileName(title: string, format: ExportFormat): string {
  const base =
    safeFileName(title)
      .replace(/[\s.()]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'song';
  return `${base}.${format === 'midi' ? 'mid' : format}`;
}

/** 16-bit PCM samples, as both WAV and MP3 need them. */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataSize = frames * count * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 2, true);
  view.setUint16(32, count * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataSize, true);
  const pcm = channels.map(toInt16);
  let at = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < count; c++) {
      view.setInt16(at, pcm[c]![f]!, true);
      at += 2;
    }
  }
  return buffer;
}

/**
 * Bytes from the player were produced next to code we do not trust, so check that they are what they claim to be
 * before offering them as a file.
 */
export function isExportedAudio(format: 'wav' | 'mp3', buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4 || buffer.byteLength > MAX_EXPORT_BYTES) return false;
  const b = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 12));
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (format === 'wav') return buffer.byteLength >= 44 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
  return ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0);
}

// ---------- MIDI ----------

const midiNoteSchema = z.object({
  tick: z.number().int().min(0),
  duration: z.number().int().min(1),
  pitch: z.number().int().min(0).max(127),
  velocity: z.number().int().min(1).max(127),
});

export const midiExportSchema = z.object({
  bpm: z.number().positive().max(2000),
  beats: z.number().int().min(1).max(32),
  /** Events that have no notes in MIDI, such as samples that are not drums. */
  skipped: z.number().int().min(0),
  tracks: z
    .array(
      z.object({
        name: z.string().max(80),
        drums: z.boolean(),
        program: z.number().int().min(0).max(127),
        notes: z.array(midiNoteSchema).max(MAX_MIDI_NOTES),
      }),
    )
    .max(64),
});
export type MidiExport = z.infer<typeof midiExportSchema>;

/** One event of a pattern, as the player reads it. Times are in cycles. */
export interface ExportEvent {
  begin: number;
  end: number;
  value: { note?: unknown; s?: unknown; velocity?: unknown } | null;
}

const DRUM_KEYS: Record<(typeof DRUM_SOUNDS)[number], number> = {
  bd: 36,
  rim: 37,
  sd: 38,
  cp: 39,
  lt: 41,
  hh: 42,
  mt: 45,
  oh: 46,
  ht: 48,
  cr: 49,
  rd: 51,
};

const SYNTH_PROGRAMS: Record<string, number> = {
  square: 80,
  sine: 80,
  triangle: 80,
  sawtooth: 81,
  supersaw: 81,
};

/** The inverse of gmSoundForProgram. */
function programForSound(sound: string): number {
  const gm = (GM_SOUNDS as readonly string[]).indexOf(sound);
  if (gm >= 0) return gm === 0 ? 0 : gm + 3;
  return SYNTH_PROGRAMS[sound] ?? 0;
}

const SEMITONES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** c4 is 60, and without an octave the default is 3, as in Strudel. */
export function noteToMidiNumber(note: unknown): number | null {
  if (typeof note === 'number') return Number.isFinite(note) ? Math.round(note) : null;
  if (typeof note !== 'string') return null;
  const m = /^([a-gA-G])([#bsf]*)(-?\d*)$/.exec(note);
  if (!m) return null;
  let semitone = SEMITONES[m[1]!.toLowerCase()]!;
  for (const c of m[2]!) semitone += c === '#' || c === 's' ? 1 : -1;
  return (Number(m[3] || 3) + 1) * 12 + semitone;
}

export function eventsToMidi(input: {
  tracks: { name: string; events: ExportEvent[] }[];
  cyclesPerSecond: number;
  beats: number;
}): MidiExport {
  const ticksPerCycle = input.beats * EXPORT_PPQ;
  const out: MidiExport['tracks'] = [];
  let skipped = 0;
  for (const track of input.tracks) {
    const parts = new Map<string, MidiExport['tracks'][number]>();
    for (const e of track.events) {
      const value = e.value ?? {};
      const sound = typeof value.s === 'string' ? value.s.split(':')[0]!.toLowerCase() : '';
      const isDrum = value.note === undefined && (DRUM_SOUNDS as readonly string[]).includes(sound);
      const pitch = isDrum ? DRUM_KEYS[sound as keyof typeof DRUM_KEYS] : noteToMidiNumber(value.note);
      if (pitch === null || pitch === undefined || pitch < 0 || pitch > 127) {
        skipped++;
        continue;
      }
      const key = isDrum ? 'drums' : sound;
      let part = parts.get(key);
      if (!part) {
        part = { name: track.name, drums: isDrum, program: isDrum ? 0 : programForSound(sound), notes: [] };
        parts.set(key, part);
      }
      const velocity = typeof value.velocity === 'number' ? value.velocity : 100 / 127;
      part.notes.push({
        tick: Math.round(e.begin * ticksPerCycle),
        duration: Math.max(1, Math.round((e.end - e.begin) * ticksPerCycle)),
        pitch,
        velocity: Math.max(1, Math.min(127, Math.round(velocity * 127))),
      });
    }
    for (const [key, part] of parts) {
      if (parts.size > 1) part.name = `${track.name} ${key}`.slice(0, 80);
      out.push(part);
    }
  }
  return {
    bpm: input.cyclesPerSecond * 60 * input.beats,
    beats: input.beats,
    skipped,
    tracks: out.slice(0, 64),
  };
}

/** Channel 10 is for drums, and the 15 others are shared when a song has more parts than that. */
export function midiExportToSpec(m: MidiExport): WriteSpec {
  let next = 0;
  return {
    ppq: EXPORT_PPQ,
    bpm: m.bpm,
    timeSignature: [m.beats, 4],
    tracks: m.tracks.map((t) => {
      if (t.drums) return { name: t.name, channel: 9, notes: t.notes };
      const channel = next % 15 >= 9 ? (next % 15) + 1 : next % 15;
      next++;
      return { name: t.name, channel, program: t.program, notes: t.notes };
    }),
  };
}
