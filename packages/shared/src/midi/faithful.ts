// MIDI → Strudel, "faithful" mode: note for note on a quantization grid.
//
//   setcpm(120/4)                                   1 cycle = 1 bar
//   piano: note(`<[c4 e4 g4 c5] [d4@3 ~] ...>`)      one mini-notation entry per bar inside <...>
//     .s("gm_piano").velocity(.79)
//
// - Durations use @weights, rests are ~, chords are [c3,e3,g3], repeated bars are compressed with !n.
// - Overlapping notes of different lengths are split into voices, layered with "," (or stack() when
//   each voice has its own velocity pattern).
// - Drums (channel 10) become s("bd sd hh ...") on a drum machine bank, one layer per drum sound.
import { MAX_CODE_LENGTH } from '../strudel/validate';
import { sanitizeTrackName } from '../strudel/tracks';
import { analyzeMidi, midiParts, prefersFlats, ticksPerBar } from './analyze';
import { DRUM_SOUNDS, drumSoundForKey } from './gm';
import { MidiError, type MidiFile, type MidiNote } from './parse';

/** Grid resolutions in steps per quarter note. */
export const GRIDS = [2, 3, 4, 6, 8, 12] as const;
export type GridSteps = (typeof GRIDS)[number];
export const GRID_LABELS: Record<GridSteps, string> = {
  2: '1/8',
  3: '1/8 triplets',
  4: '1/16',
  6: '1/16 triplets',
  8: '1/32',
  12: '1/16 + triplets',
};

export const MAX_IMPORT_BARS = 512;
const MAX_VOICES = 8;
export const DEFAULT_DRUM_BANK = 'RolandTR909';

export interface FaithfulOptions {
  /** Part indexes to import (default: all). */
  parts?: number[];
  grid?: GridSteps | 'auto';
  /** First bar to import, 0-based. */
  startBar?: number;
  /** Number of bars (default: to the end, at most MAX_IMPORT_BARS). */
  bars?: number;
  /** Keep note velocities (dynamics, accents). Default true. */
  velocity?: boolean;
  /** Shown in the header comment. */
  fileName?: string;
}

export interface ConversionResult {
  code: string;
  grid: GridSteps;
  startBar: number;
  bars: number;
  warnings: string[];
  stats: { tracks: number; notes: number; droppedNotes: number; shortenedNotes: number };
}

interface Ev {
  start: number;
  end: number;
  /** Mini-notation token: "c4", "[c4,e4]", "bd". */
  token: string;
  velocity: number;
  pitch: number;
}

const SHARPS = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const FLATS = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];

export function noteName(pitch: number, flats = false): string {
  if (pitch < 12) return String(pitch); // below c0: plain MIDI number
  return `${(flats ? FLATS : SHARPS)[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Number with up to 2 decimals and no leading zero: 0.79 -> ".79", 1 -> "1". */
function num(x: number): string {
  const s = (Math.round(x * 100) / 100).toString();
  return s.startsWith('0.') ? s.slice(1) : s;
}

function stepsPerBarFor(file: MidiFile, grid: number): number | null {
  const ts = file.timeSignatures[0] ?? { numerator: 4, denominator: 4 };
  const spb = (grid * 4 * ts.numerator) / ts.denominator;
  return Number.isInteger(spb) ? spb : null;
}

/** Picks the coarsest grid on which the note starts sit (almost) exactly; 1/16 for played-in MIDI. */
export function detectGrid(file: MidiFile, notes: MidiNote[]): GridSteps {
  if (!notes.length) return 4;
  for (const g of GRIDS) {
    if (!stepsPerBarFor(file, g)) continue;
    const step = file.ppq / g;
    let err = 0;
    for (const n of notes) {
      const q = Math.round(n.tick / step) * step;
      err += Math.abs(n.tick - q);
    }
    if (err / notes.length / file.ppq <= 0.01) return g;
  }
  return stepsPerBarFor(file, 4) ? 4 : (GRIDS.find((g) => stepsPerBarFor(file, g)) ?? 4);
}

/**
 * One bar of one voice as mini-notation. `uniform` (drums) ignores durations and puts the hits on equal
 * slots, which gives the familiar drum notation ("bd ~ sd ~"). Repeating groups become "[...]*n".
 */
function renderBar(events: Ev[], barStart: number, spb: number, withVelocity: boolean, uniform = false) {
  type Item = { w: number; token: string; vel: string };
  const items: Item[] = [];
  if (uniform) {
    const slot = events.reduce((g, e) => gcd(g, e.start - barStart), spb);
    const slots: Item[] = Array.from({ length: spb / slot }, () => ({ w: 1, token: '~', vel: '~' }));
    for (const e of events)
      slots[(e.start - barStart) / slot] = { w: 1, token: e.token, vel: num(e.velocity / 127) };
    items.push(...slots);
  } else {
    let cursor = barStart;
    for (const e of events) {
      if (e.start > cursor) items.push({ w: e.start - cursor, token: '~', vel: '~' });
      items.push({ w: e.end - e.start, token: e.token, vel: num(e.velocity / 127) });
      cursor = e.end;
    }
    if (cursor < barStart + spb) items.push({ w: barStart + spb - cursor, token: '~', vel: '~' });
  }

  // Smallest repeating group; velocities must repeat too, so notes and velocities keep the same structure.
  const same = (a: Item, b: Item) => a.w === b.w && a.token === b.token && (!withVelocity || a.vel === b.vel);
  let period = items.length;
  for (let p = 1; p < items.length; p++) {
    if (items.length % p === 0 && items.every((it, i) => same(it, items[i % p]!))) {
      period = p;
      break;
    }
  }
  const unit = items.slice(0, period);
  const repeat = items.length / period;

  const join = (key: 'token' | 'vel') => {
    if (unit.every((i) => i.token === '~')) return '~';
    const g = unit.reduce((acc, i) => gcd(acc, i.w), 0);
    const inner = unit.map((i) => (i.w / g > 1 ? `${i[key]}@${i.w / g}` : i[key])).join(' ');
    const group = unit.length > 1 ? `[${inner}]` : inner;
    return repeat > 1 ? `${group}*${repeat}` : group;
  };
  return { notes: join('token'), velocity: join('vel') };
}

/** Bars → `<bar1 bar2!3 ...>`, 4 bars per line. */
function renderSequence(bars: string[], indent: string): string {
  const entries: { text: string; count: number }[] = [];
  for (const b of bars) {
    const last = entries[entries.length - 1];
    if (last && last.text === b) last.count++;
    else entries.push({ text: b, count: 1 });
  }
  // The same bar all the way through: no need for <...> at all.
  if (entries.length === 1) return entries[0]!.text;
  const parts = entries.map(({ text, count }) => {
    const t = count > 1 && text.includes('*') && !text.startsWith('[') ? `[${text}]` : text;
    return { text: count > 1 ? `${t}!${count}` : t, count };
  });
  const lines: string[] = [];
  let line: string[] = [];
  let barsInLine = 0;
  for (const p of parts) {
    line.push(p.text);
    barsInLine += p.count;
    if (barsInLine >= 4) {
      lines.push(line.join(' '));
      line = [];
      barsInLine = 0;
    }
  }
  if (line.length) lines.push(line.join(' '));
  return lines.length === 1 ? `<${lines[0]}>` : `<${lines.join(`\n${indent} `)}>`;
}

const quote = (mini: string) => (mini.includes('\n') ? `\`${mini}\`` : `"${mini}"`);

export function convertFaithful(file: MidiFile, options: FaithfulOptions = {}): ConversionResult {
  const analysis = analyzeMidi(file);
  const all = midiParts(file);
  const selected = options.parts ? all.filter((p) => options.parts!.includes(p.part.index)) : all;
  if (!selected.length) throw new MidiError('Choose at least one track to import');

  const warnings: string[] = [];
  const tpb = ticksPerBar(file);
  const startBar = Math.max(0, Math.min(options.startBar ?? 0, analysis.bars - 1));
  const bars = Math.max(
    1,
    Math.min(options.bars ?? analysis.bars - startBar, analysis.bars - startBar, MAX_IMPORT_BARS),
  );
  if (!options.bars && analysis.bars - startBar > MAX_IMPORT_BARS)
    warnings.push(`Only the first ${MAX_IMPORT_BARS} bars were imported.`);
  const startTick = startBar * tpb;
  const endTick = (startBar + bars) * tpb;

  const inRange = (n: MidiNote) => n.tick >= startTick && n.tick < endTick;
  const pickedGrid = options.grid && options.grid !== 'auto' ? options.grid : null;
  let grid: number =
    pickedGrid ??
    detectGrid(
      file,
      selected.flatMap((p) => p.notes.filter(inRange)),
    );
  // Grids that do not divide the bar (e.g. triplets in 7/8) are refined until they do.
  let spb = stepsPerBarFor(file, grid);
  for (const k of [2, 3, 4, 6, 8]) {
    if (spb) break;
    const refined = stepsPerBarFor(file, grid * k);
    if (refined) {
      grid *= k;
      spb = refined;
    }
  }
  if (!spb) throw new MidiError('This time signature does not fit the chosen grid');
  const stepTicks = file.ppq / grid;
  const totalSteps = spb * bars;
  const flats = prefersFlats(analysis.key);
  const keepVelocity = options.velocity ?? true;

  if (analysis.tempoChanges > 0)
    warnings.push(
      `The file changes tempo ${analysis.tempoChanges} time(s); the import uses the first tempo (${analysis.bpm} BPM).`,
    );
  if (analysis.timeSignatureChanges > 0)
    warnings.push(
      `The file changes time signature; the import uses ${analysis.timeSignature.numerator}/${analysis.timeSignature.denominator} throughout.`,
    );

  let dropped = 0;
  let shortened = 0;
  let noteTotal = 0;
  let approximatedDrums = 0;
  const usedLabels = new Set<string>();
  const blocks: string[] = [];

  for (const { part, notes } of selected) {
    const events: Ev[] = [];
    // Quantize.
    const q: { start: number; end: number; pitch: number; velocity: number }[] = [];
    for (const n of notes) {
      if (!inRange(n)) continue;
      const start = Math.round((n.tick - startTick) / stepTicks);
      if (start >= totalSteps) continue;
      let end = Math.max(start + 1, Math.round((n.tick + n.duration - startTick) / stepTicks));
      const barEnd = (Math.floor(start / spb) + 1) * spb;
      if (end > barEnd) {
        end = barEnd;
        shortened++;
      }
      q.push({ start, end, pitch: n.pitch, velocity: n.velocity });
    }
    if (!q.length) {
      warnings.push(`"${part.name}" has no notes in the chosen bars and was skipped.`);
      continue;
    }
    noteTotal += q.length;

    let voices: Ev[][];
    if (part.isDrums) {
      // One layer per drum sound; a hit lasts until the next hit of the same sound (keeps the code short,
      // drum samples play to their end anyway).
      const bySound = new Map<string, Map<number, number>>();
      for (const n of q) {
        const { sound, exact } = drumSoundForKey(n.pitch);
        if (!exact) approximatedDrums++;
        const hits = bySound.get(sound) ?? new Map<number, number>();
        hits.set(n.start, Math.max(hits.get(n.start) ?? 0, n.velocity));
        bySound.set(sound, hits);
      }
      voices = DRUM_SOUNDS.filter((s) => bySound.has(s)).map((sound) => {
        const starts = [...bySound.get(sound)!.entries()].sort((a, b) => a[0] - b[0]);
        return starts.map(([start, velocity], i) => {
          const barEnd = (Math.floor(start / spb) + 1) * spb;
          const next = starts[i + 1]?.[0] ?? totalSteps;
          return { start, end: Math.min(next, barEnd), token: sound, velocity, pitch: 0 };
        });
      });
    } else {
      // Notes with the same start and end form a chord.
      const chords = new Map<
        string,
        { start: number; end: number; pitches: Set<number>; velocity: number }
      >();
      for (const n of q) {
        const key = `${n.start}:${n.end}`;
        const c = chords.get(key) ?? { start: n.start, end: n.end, pitches: new Set<number>(), velocity: 0 };
        c.pitches.add(n.pitch);
        c.velocity = Math.max(c.velocity, n.velocity);
        chords.set(key, c);
      }
      for (const c of chords.values()) {
        const pitches = [...c.pitches].sort((a, b) => a - b);
        const names = pitches.map((p) => noteName(p, flats));
        events.push({
          start: c.start,
          end: c.end,
          token: names.length > 1 ? `[${names.join(',')}]` : names[0]!,
          velocity: c.velocity,
          pitch: pitches[pitches.length - 1]!,
        });
      }
      // Voice allocation: earliest first, higher notes first, each event into the first free voice.
      events.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
      voices = [];
      const voiceEnd: number[] = [];
      for (const e of events) {
        let v = voiceEnd.findIndex((end) => end <= e.start);
        if (v < 0) {
          if (voices.length >= MAX_VOICES) {
            dropped += e.token.split(',').length;
            continue;
          }
          v = voices.length;
          voices.push([]);
          voiceEnd.push(0);
        }
        voices[v]!.push(e);
        voiceEnd[v] = e.end;
      }
    }

    // Dynamics: one value for the track when velocities hardly change, otherwise a pattern per voice.
    const vels = voices.flat().map((e) => e.velocity);
    const vMin = vels.reduce((m, v) => Math.min(m, v), 127);
    const vMax = vels.reduce((m, v) => Math.max(m, v), 0);
    const perNoteVelocity = keepVelocity && vMax - vMin > 10;
    const constVelocity =
      keepVelocity && !perNoteVelocity ? vels.reduce((s, v) => s + v, 0) / vels.length : null;

    let label = sanitizeTrackName(
      part.isDrums && /^(drums?|percussion|track)\b/i.test(part.name) ? 'drums' : part.name,
    );
    for (let i = 2; usedLabels.has(label); i++) label = `${sanitizeTrackName(part.name)}_${i}`.slice(0, 32);
    usedLabels.add(label);

    const fn = part.isDrums ? 's' : 'note';
    const lanes = voices.map((voice) => {
      const notesBars: string[] = [];
      const velBars: string[] = [];
      for (let b = 0; b < bars; b++) {
        const from = b * spb;
        const inBar = voice.filter((e) => e.start >= from && e.start < from + spb);
        const r = renderBar(inBar, from, spb, perNoteVelocity, part.isDrums);
        notesBars.push(r.notes);
        velBars.push(r.velocity);
      }
      // Bars are compressed with !n only where both notes and velocities repeat.
      return { notesBars, velBars };
    });

    const tail = part.isDrums ? `.bank("${DEFAULT_DRUM_BANK}")` : `.s("${part.sound}")`;
    let body: string;
    if (perNoteVelocity) {
      const voiceCode = lanes.map((l) => {
        const pairs = l.notesBars.map((n, i) => `${n}\uE000${l.velBars[i]}`);
        // Render both sequences from the same run-length groups so they stay aligned.
        const notesSeq = renderPairs(pairs, 0, '    ');
        const velSeq = renderPairs(pairs, 1, '    ');
        return `${fn}(${quote(notesSeq)}).velocity(${quote(velSeq)})`;
      });
      body =
        voiceCode.length === 1 ? `${voiceCode[0]}${tail}` : `stack(\n  ${voiceCode.join(',\n  ')},\n)${tail}`;
    } else {
      const layers = lanes.map((l) => renderSequence(l.notesBars, '  '));
      const mini = layers.join(layers.some((x) => x.includes('\n')) ? ',\n  ' : ', ');
      body = `${fn}(${quote(mini)})${tail}${constVelocity !== null ? `.velocity(${num(constVelocity / 127)})` : ''}`;
    }
    blocks.push(`${label}: ${body}`);
  }

  if (!blocks.length) throw new MidiError('The chosen tracks have no notes in these bars');
  if (approximatedDrums)
    warnings.push(
      `${approximatedDrums} drum hit(s) use a sound without a close match in drum machines (e.g. cowbell, congas); they were replaced with a similar one.`,
    );
  if (shortened) warnings.push(`${shortened} note(s) longer than the bar were shortened to the bar line.`);
  if (dropped) warnings.push(`${dropped} note(s) were dropped (more than ${MAX_VOICES} overlapping voices).`);

  const ts = analysis.timeSignature;
  const quarters = (4 * ts.numerator) / ts.denominator;
  const safeName = (options.fileName ?? '')
    .replace(/[^\w .()-]/g, '')
    .slice(0, 60)
    .trim();
  const header = [
    `// Imported from MIDI${safeName ? ` "${safeName}"` : ''}: bars ${startBar + 1}-${startBar + bars}, ${
      GRID_LABELS[grid as GridSteps] ?? `1/${grid * 4}`
    } grid, ${ts.numerator}/${ts.denominator}`,
    `setcpm(${num(analysis.bpm)}/${num(quarters)})`,
  ];
  const code = `${header.join('\n')}\n\n${blocks.join('\n\n')}\n`;
  if (code.length > MAX_CODE_LENGTH)
    throw new MidiError('The result is too long. Import fewer bars or tracks, or use a coarser grid.');

  return {
    code,
    grid: grid as GridSteps,
    startBar,
    bars,
    warnings,
    stats: { tracks: blocks.length, notes: noteTotal, droppedNotes: dropped, shortenedNotes: shortened },
  };
}

/** renderSequence over (notes, velocity) pairs, so both are compressed with the same !n groups. */
function renderPairs(pairs: string[], side: 0 | 1, indent: string): string {
  const grouped: string[] = [];
  const counts: number[] = [];
  for (const p of pairs) {
    if (grouped.length && grouped[grouped.length - 1] === p) counts[counts.length - 1]!++;
    else {
      grouped.push(p);
      counts.push(1);
    }
  }
  const expanded: string[] = [];
  grouped.forEach((p, i) => {
    const text = p.split('\uE000')[side]!;
    // Mark groups so renderSequence merges exactly these runs (and nothing else).
    for (let k = 0; k < counts[i]!; k++) expanded.push(`${text}\uE001${i}`);
  });
  return renderSequence(expanded, indent).replace(/\uE001\d+/g, '');
}
