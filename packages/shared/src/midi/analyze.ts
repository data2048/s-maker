// Analysis of a parsed MIDI file: parts (track × channel), tempo, meter, key, ranges.
import { classifyMidi, type MidiClassification } from './classify';
import { GM_DRUM_CHANNEL, gmProgramName, gmSoundForProgram } from './gm';
import type { MidiFile, MidiNote } from './parse';

/** A part is the notes of one channel in one track: what becomes one Strudel track. */
export interface MidiPart {
  index: number;
  trackIndex: number;
  channel: number;
  name: string;
  isDrums: boolean;
  program: number;
  programName: string;
  /** Strudel sound: a gm_* soundfont, or "drums" for channel 10. */
  sound: string;
  noteCount: number;
  low: number;
  high: number;
  maxPolyphony: number;
  /** First and last bar with notes (0-based). */
  firstBar: number;
  lastBar: number;
}

export interface MidiKey {
  tonic: string;
  mode: 'major' | 'minor';
  /** "file" when the file has a key signature, "detected" when estimated from the notes. */
  source: 'file' | 'detected';
  /** Correlation of the best key profile (0–1); low values mean the key is ambiguous. */
  confidence: number;
}

export interface MidiAnalysis {
  format: 0 | 1;
  ppq: number;
  bpm: number;
  tempoChanges: number;
  timeSignature: { numerator: number; denominator: number };
  timeSignatureChanges: number;
  key: MidiKey | null;
  bars: number;
  durationSeconds: number;
  noteCount: number;
  parts: MidiPart[];
  classification: MidiClassification;
}

const PITCH_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PITCH_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR_FROM_SF = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const MINOR_FROM_SF = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];

// Krumhansl–Kessler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: number[], b: number[]): number {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Krumhansl–Schmuckler key finding on a duration-weighted pitch-class histogram. */
export function detectKey(notes: Pick<MidiNote, 'pitch' | 'duration'>[]): MidiKey | null {
  if (notes.length < 8) return null;
  const hist = new Array<number>(12).fill(0);
  for (const n of notes) hist[n.pitch % 12]! += n.duration;
  let best: MidiKey | null = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = hist.slice(tonic).concat(hist.slice(0, tonic));
    for (const [mode, profile] of [
      ['major', MAJOR_PROFILE],
      ['minor', MINOR_PROFILE],
    ] as const) {
      const r = correlation(rotated, profile);
      if (!best || r > best.confidence) {
        const names =
          mode === 'major' && [5, 10, 3, 8, 1].includes(tonic) ? PITCH_NAMES_FLAT : PITCH_NAMES_SHARP;
        const minorNames = [3, 10, 5, 0, 7].includes(tonic) ? PITCH_NAMES_FLAT : PITCH_NAMES_SHARP;
        best = {
          tonic: (mode === 'major' ? names : minorNames)[tonic]!,
          mode,
          source: 'detected',
          confidence: Math.max(0, r),
        };
      }
    }
  }
  return best;
}

export function keyFromSignature(sf: number, minor: boolean): MidiKey {
  return {
    tonic: (minor ? MINOR_FROM_SF : MAJOR_FROM_SF)[sf + 7]!,
    mode: minor ? 'minor' : 'major',
    source: 'file',
    confidence: 1,
  };
}

/** Whether to spell notes with flats (Bb) rather than sharps (A#) in this key. */
export function prefersFlats(key: MidiKey | null): boolean {
  return (
    !!key &&
    (key.tonic.endsWith('b') ||
      (key.mode === 'major' && key.tonic === 'F') ||
      (key.mode === 'minor' && ['D', 'G', 'C', 'F'].includes(key.tonic)))
  );
}

export function ticksPerBar(file: MidiFile): number {
  const ts = file.timeSignatures[0] ?? { numerator: 4, denominator: 4 };
  return (file.ppq * 4 * ts.numerator) / ts.denominator;
}

function maxPolyphony(notes: MidiNote[]): number {
  const edges: [number, number][] = [];
  for (const n of notes) edges.push([n.tick, 1], [n.tick + n.duration, -1]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of edges) max = Math.max(max, (cur += d));
  return max;
}

/** Splits tracks into parts by channel, keeping file order. */
export function midiParts(file: MidiFile): { part: MidiPart; notes: MidiNote[] }[] {
  const tpb = ticksPerBar(file);
  const out: { part: MidiPart; notes: MidiNote[] }[] = [];
  // Program per channel anywhere in the file, for tracks that rely on an earlier program change.
  const globalProgram = new Map<number, number>();
  for (const t of file.tracks)
    for (const p of t.programs) if (!globalProgram.has(p.channel)) globalProgram.set(p.channel, p.program);

  for (const track of file.tracks) {
    const byChannel = new Map<number, MidiNote[]>();
    for (const n of track.notes) {
      const list = byChannel.get(n.channel) ?? [];
      list.push(n);
      byChannel.set(n.channel, list);
    }
    const channels = [...byChannel.keys()].sort((a, b) => a - b);
    for (const channel of channels) {
      const notes = byChannel.get(channel)!;
      const isDrums = channel === GM_DRUM_CHANNEL;
      const program =
        track.programs.find((p) => p.channel === channel)?.program ?? globalProgram.get(channel) ?? 0;
      const programName = isDrums ? 'Drums' : gmProgramName(program);
      let name = track.name || track.instrumentName || programName;
      if (channels.length > 1) name = `${name} ch${channel + 1}`;
      let low = 127;
      let high = 0;
      for (const n of notes) {
        low = Math.min(low, n.pitch);
        high = Math.max(high, n.pitch);
      }
      const last = notes.reduce((m, n) => Math.max(m, n.tick), 0);
      out.push({
        part: {
          index: out.length,
          trackIndex: track.index,
          channel,
          name,
          isDrums,
          program,
          programName,
          sound: isDrums ? 'drums' : gmSoundForProgram(program),
          noteCount: notes.length,
          low,
          high,
          maxPolyphony: maxPolyphony(notes),
          firstBar: Math.floor(notes[0]!.tick / tpb),
          lastBar: Math.floor(last / tpb),
        },
        notes,
      });
    }
  }
  return out;
}

/** Seconds from tick 0 to `tick`, following tempo changes. */
function ticksToSeconds(file: MidiFile, tick: number): number {
  let seconds = 0;
  let lastTick = 0;
  let bpm = 120;
  for (const t of file.tempos) {
    if (t.tick >= tick) break;
    seconds += ((t.tick - lastTick) / file.ppq) * (60 / bpm);
    lastTick = t.tick;
    bpm = t.bpm;
  }
  return seconds + ((tick - lastTick) / file.ppq) * (60 / bpm);
}

export function analyzeMidi(file: MidiFile): MidiAnalysis {
  const parts = midiParts(file);
  const ts = file.timeSignatures[0] ?? { numerator: 4, denominator: 4 };
  const tpb = ticksPerBar(file);
  const pitched = parts.filter((p) => !p.part.isDrums).flatMap((p) => p.notes);
  const sig = file.keySignatures[0];
  // A key signature of C major (sf 0) is often just a default from the exporting program: estimate instead.
  const detected = detectKey(pitched);
  const key =
    sig && !(sig.sf === 0 && !sig.minor && detected) ? keyFromSignature(sig.sf, sig.minor) : detected;
  const distinct = <T>(xs: T[]) =>
    xs.filter((x, i) => i === 0 || JSON.stringify(x) !== JSON.stringify(xs[i - 1]));
  const lastNoteEnd = parts.reduce(
    (m, p) => p.notes.reduce((mm, n) => Math.max(mm, n.tick + n.duration), m),
    0,
  );
  const tempoChanges = Math.max(0, distinct(file.tempos.map((t) => Math.round(t.bpm * 100))).length - 1);
  const partInfo = parts.map((p) => p.part);
  return {
    format: file.format,
    ppq: file.ppq,
    bpm: Math.round((file.tempos[0]?.bpm ?? 120) * 100) / 100,
    tempoChanges,
    timeSignature: { numerator: ts.numerator, denominator: ts.denominator },
    timeSignatureChanges: Math.max(
      0,
      distinct(file.timeSignatures.map((t) => [t.numerator, t.denominator])).length - 1,
    ),
    key,
    bars: Math.max(1, Math.ceil(lastNoteEnd / tpb)),
    durationSeconds: Math.round(ticksToSeconds(file, lastNoteEnd) * 10) / 10,
    noteCount: parts.reduce((s, p) => s + p.notes.length, 0),
    parts: partInfo,
    classification: classifyMidi({ parts: partInfo, tempoChanges }),
  };
}
