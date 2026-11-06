// Heuristic guess of what kind of MIDI file this is. The user can always correct it.
import type { MidiAnalysis, MidiPart } from './analyze';

export const MIDI_TYPES = [
  'band',
  'solo_piano',
  'orchestral',
  'electronic',
  'jazz',
  'chiptune',
  'other',
] as const;
export type MidiType = (typeof MIDI_TYPES)[number];

export const MIDI_TYPE_LABELS: Record<MidiType, string> = {
  band: 'Band (pop/rock)',
  solo_piano: 'Solo piano',
  orchestral: 'Orchestra / classical',
  electronic: 'Electronic / loop',
  jazz: 'Jazz',
  chiptune: 'Chiptune / game',
  other: 'Other',
};

export interface MidiClassification {
  type: MidiType;
  /** 0–1: how far the best guess is ahead. Below 0.5 the guess is shaky. */
  confidence: number;
  /** Short reasons in plain English. */
  reasons: string[];
}

const inRange = (p: number, from: number, to: number) => p >= from && p <= to;
const isPiano = (p: number) => inRange(p, 0, 7);
const isGuitar = (p: number) => inRange(p, 24, 31);
const isBass = (p: number) => inRange(p, 32, 39);
const isOrchestral = (p: number) =>
  inRange(p, 40, 47) || inRange(p, 48, 49) || inRange(p, 52, 53) || inRange(p, 56, 61) || inRange(p, 68, 75);
const isSynth = (p: number) =>
  inRange(p, 38, 39) || inRange(p, 50, 51) || inRange(p, 62, 63) || inRange(p, 80, 103);
const isChip = (p: number) => p === 80 || p === 81;
const isJazzVoice = (p: number) => inRange(p, 64, 67) || p === 56 || p === 26 || p === 4;

export function classifyMidi(a: Pick<MidiAnalysis, 'parts' | 'tempoChanges'>): MidiClassification {
  const pitched: MidiPart[] = a.parts.filter((p) => !p.isDrums);
  const programs = pitched.map((p) => p.program);
  const hasDrums = a.parts.some((p) => p.isDrums);
  const n = Math.max(1, programs.length);
  const share = (f: (p: number) => boolean) => programs.filter(f).length / n;

  const scores: Record<MidiType, number> = {
    band: 0,
    solo_piano: 0,
    orchestral: 0,
    electronic: 0,
    jazz: 0,
    chiptune: 0,
    other: 0.3,
  };
  const reasons: Partial<Record<MidiType, string[]>> = {};
  const add = (t: MidiType, by: number, why: string) => {
    scores[t] += by;
    (reasons[t] ??= []).push(why);
  };

  if (programs.length >= 1 && programs.length <= 2 && !hasDrums && share(isPiano) === 1)
    add('solo_piano', 2, 'only piano, no drums');

  if (share(isOrchestral) >= 0.6 && programs.length >= 3)
    add('orchestral', 1.5, 'mostly strings, brass and woodwinds');
  if (!hasDrums && share(isOrchestral) >= 0.4) add('orchestral', 0.5, 'no drum kit');
  if (a.tempoChanges >= 3) add('orchestral', 0.3, 'tempo changes often');

  if (hasDrums && programs.some(isBass) && programs.some((p) => isGuitar(p) || isPiano(p)))
    add('band', 1.5, 'drums, bass and guitar or keys');
  if (hasDrums && share(isGuitar) >= 0.25) add('band', 0.5, 'several guitars');

  if (share(isSynth) >= 0.4) add('electronic', 1.2, 'mostly synth sounds');
  if (hasDrums && share(isSynth) >= 0.25) add('electronic', 0.5, 'drums with synths');
  if (a.tempoChanges === 0 && share(isSynth) >= 0.25) add('electronic', 0.2, 'steady tempo');

  if (hasDrums && programs.includes(32) && programs.some(isJazzVoice))
    add('jazz', 1.8, 'acoustic bass, drums and sax, trumpet or similar');
  if (share((p) => inRange(p, 64, 67)) >= 0.25) add('jazz', 0.5, 'saxophones');

  if (share(isChip) >= 0.5) add('chiptune', 2, 'square and sawtooth leads');

  const ranked = (Object.entries(scores) as [MidiType, number][]).sort((x, y) => y[1] - x[1]);
  const [best, second] = ranked;
  const type = best![0];
  const lead = best![1] - second![1];
  return {
    type,
    confidence: Math.round(Math.min(1, lead / 1.5) * 100) / 100,
    reasons: reasons[type] ?? ['no clear signs of a known style'],
  };
}
