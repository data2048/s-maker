// MIDI → Strudel, "essence" mode: the song reduced to its repeating sections and dominant patterns.
//
//   // Form: A (8) B (4) A (8)
//   const lead_a = note("<[c4 e4] g4>").velocity(.7)
//   const lead_b = note("a4").velocity(.8)
//   lead: arrange([8, lead_a], [4, lead_b], [8, lead_a]).s("gm_flute")
//
// Steps: quantize on a coarse grid, split the bars into blocks (1, 2, 4, 8… bars), group similar blocks
// into sections, and for each section keep the most common version of every bar. Small variations, fills
// and inner voices are dropped on purpose; faithful mode keeps them.
import { MAX_CODE_LENGTH } from '../strudel/validate';
import { analyzeMidi, midiParts, prefersFlats, ticksPerBar } from './analyze';
import {
  DEFAULT_DRUM_BANK,
  detectGrid,
  GRID_LABELS,
  MAX_IMPORT_BARS,
  num,
  partLabel,
  partVoices,
  quote,
  renderBar,
  renderSequence,
  safeFileName,
  stepsPerBarFor,
  type ConversionResult,
  type Ev,
  type FaithfulOptions,
  type GridSteps,
} from './faithful';
import { MidiError, type MidiFile } from './parse';

const SIMILAR = 0.7;
const ESSENCE_VOICES = 3;

export interface FormSection {
  /** A, B, C… */
  label: string;
  /** First bar in the imported range, 0-based. */
  startBar: number;
  bars: number;
}

export interface FormResult {
  /** Block length in bars. */
  blockBars: number;
  sections: FormSection[];
  /** Blocks (by index) belonging to each section label. */
  clusters: { label: string; blocks: number[] }[];
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return common / (a.size + b.size - common);
}

const sectionLabel = (i: number) =>
  i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)}`;

/**
 * Finds the form from one set of events per bar. Tries block lengths of 1, 2, 4… bars and takes the one
 * that needs the least material: distinct bars to write, plus a small cost per section in the arrangement.
 */
export function detectForm(bars: Set<string>[]): FormResult {
  let best: (FormResult & { cost: number }) | null = null;
  for (const L of [1, 2, 4, 8, 16, 32]) {
    if (L > bars.length) break;
    const blocks: { start: number; length: number; cluster: number }[] = [];
    const clusters: { first: number; length: number; blocks: number[] }[] = [];
    for (let start = 0, i = 0; start < bars.length; start += L, i++) {
      const length = Math.min(L, bars.length - start);
      let cluster = clusters.findIndex((c) => {
        if (c.length !== length) return false;
        let sum = 0;
        for (let k = 0; k < length; k++) sum += jaccard(bars[c.first + k]!, bars[start + k]!);
        return sum / length >= SIMILAR;
      });
      if (cluster < 0) {
        cluster = clusters.length;
        clusters.push({ first: start, length, blocks: [] });
      }
      clusters[cluster]!.blocks.push(i);
      blocks.push({ start, length, cluster });
    }
    const sections: FormSection[] = [];
    for (const b of blocks) {
      const last = sections[sections.length - 1];
      const label = sectionLabel(b.cluster);
      if (last && last.label === label) last.bars += b.length;
      else sections.push({ label, startBar: b.start, bars: b.length });
    }
    const cost = clusters.reduce((sum, c) => sum + c.length, 0) + sections.length * 0.25;
    if (!best || cost < best.cost) {
      best = {
        cost,
        blockBars: L,
        sections,
        clusters: clusters.map((c, i) => ({ label: sectionLabel(i), blocks: c.blocks })),
      };
    }
  }
  if (!best) throw new MidiError('The chosen tracks have no bars');
  return { blockBars: best.blockBars, sections: best.sections, clusters: best.clusters };
}

export interface EssenceResult extends ConversionResult {
  form: FormSection[];
  /** Notes written in the patterns, once per section (faithful would need `stats.notes`). */
  keptNotes: number;
}

/** Coarser than faithful: played-in or very fine material is reduced to 1/16 (triplet grids are kept). */
function essenceGrid(file: MidiFile, detected: GridSteps): GridSteps {
  const g: GridSteps = detected === 8 || detected === 12 ? 4 : detected;
  return stepsPerBarFor(file, g) ? g : detected;
}

/** A bar list that is a repetition of a shorter loop is reduced to that loop. */
function shortestLoop(bars: string[]): string[] {
  for (let p = 1; p < bars.length; p++) {
    if (bars.length % p === 0 && bars.every((b, i) => b === bars[i % p])) return bars.slice(0, p);
  }
  return bars;
}

export function convertEssence(file: MidiFile, options: FaithfulOptions = {}): EssenceResult {
  const analysis = analyzeMidi(file);
  const all = midiParts(file);
  const selected = options.parts ? all.filter((p) => options.parts!.includes(p.part.index)) : all;
  if (!selected.length) throw new MidiError('Choose at least one track to import');

  const tpb = ticksPerBar(file);
  const startBar = Math.max(0, Math.min(options.startBar ?? 0, analysis.bars - 1));
  const bars = Math.max(
    1,
    Math.min(options.bars ?? analysis.bars - startBar, analysis.bars - startBar, MAX_IMPORT_BARS),
  );
  const startTick = startBar * tpb;
  const endTick = (startBar + bars) * tpb;
  const inRange = selected.flatMap((p) => p.notes.filter((n) => n.tick >= startTick && n.tick < endTick));
  const picked = options.grid && options.grid !== 'auto' ? options.grid : null;
  const grid = picked ?? essenceGrid(file, detectGrid(file, inRange));
  const spb = stepsPerBarFor(file, grid);
  if (!spb) throw new MidiError('This time signature does not fit the chosen grid');
  const keepVelocity = options.velocity ?? true;
  const ctx = {
    startTick,
    endTick,
    stepTicks: file.ppq / grid,
    spb,
    totalSteps: spb * bars,
    flats: prefersFlats(analysis.key),
    maxVoices: ESSENCE_VOICES,
  };

  const warnings: string[] = [];
  if (analysis.tempoChanges > 0)
    warnings.push(
      `The file changes tempo ${analysis.tempoChanges} time(s); the import uses the first tempo (${analysis.bpm} BPM).`,
    );
  if (analysis.timeSignatureChanges > 0)
    warnings.push(
      `The file changes time signature; the import uses ${analysis.timeSignature.numerator}/${analysis.timeSignature.denominator} throughout.`,
    );

  // Per part: voices, split per bar.
  const parts = selected
    .map(({ part, notes }) => {
      const q = partVoices(part, notes, ctx);
      if (!q.noteCount) warnings.push(`"${part.name}" has no notes in the chosen bars and was skipped.`);
      const barEvents: Ev[][][] = Array.from({ length: bars }, (_, b) =>
        q.voices.map((v) => v.filter((e) => Math.floor(e.start / spb) === b)),
      );
      return { part, ...q, barEvents };
    })
    .filter((p) => p.noteCount > 0);
  if (!parts.length) throw new MidiError('The chosen tracks have no notes in these bars');

  // One set of events per bar across all parts; drives the form detection.
  const barSets = Array.from({ length: bars }, (_, b) => {
    const set = new Set<string>();
    for (const p of parts)
      for (const voice of p.barEvents[b]!)
        for (const e of voice) set.add(`${p.part.index}:${e.start - b * spb}:${e.token}`);
    return set;
  });
  const form = detectForm(barSets);
  const L = form.blockBars;

  const used = new Set<string>();
  const consts: string[] = [];
  const blocks: string[] = [];
  const multi = form.clusters.length > 1;
  let kept = 0;
  let total = 0;

  for (const p of parts) {
    const label = partLabel(p.part, used);
    total += p.noteCount;
    const fn = p.part.isDrums ? 's' : 'note';
    const tail = p.part.isDrums ? `.bank("${DEFAULT_DRUM_BANK}")` : `.s("${p.part.sound}")`;
    const bodies = new Map<string, string | null>();

    for (const cluster of form.clusters) {
      const firstBlockStart = cluster.blocks[0]! * L;
      const length = Math.min(L, bars - firstBlockStart);
      const lanes: string[][] = p.voices.map(() => []);
      const velocities: number[] = [];
      // Most common version of every bar position across the section's blocks.
      for (let pos = 0; pos < length; pos++) {
        const counts = new Map<string, { n: number; bar: number }>();
        for (const block of cluster.blocks) {
          const bar = block * L + pos;
          if (bar >= bars) continue;
          const sig = p.barEvents[bar]!.map((v) =>
            v.map((e) => `${e.start - bar * spb}-${e.end - bar * spb}:${e.token}`).join(' '),
          ).join('|');
          const c = counts.get(sig);
          if (c) c.n++;
          else counts.set(sig, { n: 1, bar });
        }
        const chosen = [...counts.values()].sort((a, b) => b.n - a.n || a.bar - b.bar)[0]!.bar;
        p.barEvents[chosen]!.forEach((voice, v) => {
          lanes[v]!.push(renderBar(voice, chosen * spb, spb, false, p.part.isDrums).notes);
          for (const e of voice) velocities.push(e.velocity);
          kept += voice.length;
        });
      }
      const layers = lanes
        .map(shortestLoop)
        .filter((lane) => lane.some((b) => b !== '~'))
        .map((lane) => renderSequence(lane, '  '));
      if (!layers.length) {
        bodies.set(cluster.label, null);
        continue;
      }
      const mini = layers.join(layers.some((x) => x.includes('\n')) ? ',\n  ' : ', ');
      const velocity =
        keepVelocity && velocities.length
          ? `.velocity(${num(velocities.reduce((s, v) => s + v, 0) / velocities.length / 127)})`
          : '';
      bodies.set(cluster.label, `${fn}(${quote(mini)})${velocity}`);
    }

    if (!multi) {
      blocks.push(`${label}: ${bodies.get(form.clusters[0]!.label) ?? 'silence'}${tail}`);
      continue;
    }
    const names = new Map<string, string>();
    for (const [sectionName, body] of bodies) {
      if (!body) continue;
      const name = `${label}_${sectionName.toLowerCase()}`;
      names.set(sectionName, name);
      consts.push(`const ${name} = ${body}`);
    }
    const entries = form.sections.map((s) => `[${s.bars}, ${names.get(s.label) ?? 'silence'}]`);
    const inline = entries.join(', ');
    blocks.push(
      `${label}: arrange(${inline.length > 90 ? `\n  ${entries.join(',\n  ')},\n` : inline})${tail}`,
    );
  }

  const dropped = parts.reduce((s, p) => s + p.dropped, 0);
  const ts = analysis.timeSignature;
  const quarters = (4 * ts.numerator) / ts.denominator;
  const safeName = safeFileName(options.fileName);
  const formText = form.sections.map((s) => `${s.label} (${s.bars})`).join(' ');
  const header = [
    `// Essence of MIDI${safeName ? ` "${safeName}"` : ''}: bars ${startBar + 1}-${startBar + bars}, ${GRID_LABELS[grid]} grid, ${ts.numerator}/${ts.denominator}`,
    `// Form: ${formText}`.slice(0, 400),
    `setcpm(${num(analysis.bpm)}/${num(quarters)})`,
  ];
  const code = `${header.join('\n')}\n\n${consts.length ? `${consts.join('\n')}\n\n` : ''}${blocks.join('\n\n')}\n`;
  if (code.length > MAX_CODE_LENGTH)
    throw new MidiError('The result is too long. Import fewer bars or tracks.');

  return {
    code,
    grid,
    startBar,
    bars,
    warnings,
    stats: { tracks: blocks.length, notes: total, droppedNotes: dropped, shortenedNotes: 0 },
    form: form.sections,
    keptNotes: kept,
  };
}
