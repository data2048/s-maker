// Fills in a Music Brief from a MIDI file. Facts only, in short phrases: the user or the agent refines it.
import type { MusicBrief } from '../brief';
import { analyzeMidi, midiParts, ticksPerBar } from './analyze';
import { MIDI_TYPE_LABELS, type MidiType } from './classify';
import type { FormSection } from './essence';
import { noteName } from './faithful';
import type { MidiFile, MidiNote } from './parse';

function dynamicsWord(v: number): string {
  if (v < 40) return 'pp';
  if (v < 60) return 'p';
  if (v < 75) return 'mp';
  if (v < 95) return 'mf';
  if (v < 112) return 'f';
  return 'ff';
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

export function briefFromMidi(
  file: MidiFile,
  opts: { parts?: number[]; form?: FormSection[]; type?: MidiType } = {},
): MusicBrief {
  const a = analyzeMidi(file);
  const all = midiParts(file);
  const selected = opts.parts ? all.filter((p) => opts.parts!.includes(p.part.index)) : all;
  const pitched = selected.filter((p) => !p.part.isDrums);
  const notes: MidiNote[] = selected.flatMap((p) => p.notes);
  const pitchedNotes = pitched.flatMap((p) => p.notes);
  const tpb = ticksPerBar(file);
  const beat = (file.ppq * 4) / a.timeSignature.denominator;
  const bars = Math.max(1, a.bars);

  // Melody: the part with the highest average pitch that is mostly single notes.
  const lead = [...pitched]
    .filter((p) => p.notes.length >= 2)
    .sort(
      (x, y) =>
        mean(y.notes.map((n) => n.pitch)) -
        y.part.maxPolyphony * 2 -
        (mean(x.notes.map((n) => n.pitch)) - x.part.maxPolyphony * 2),
    )[0];
  let melody: string | undefined;
  if (lead) {
    const steps = lead.notes.slice(1).map((n, i) => Math.abs(n.pitch - lead.notes[i]!.pitch));
    const stepwise = steps.filter((s) => s <= 2).length / Math.max(1, steps.length);
    melody = `${lead.part.name}: range ${noteName(lead.part.low)}–${noteName(lead.part.high)}, ${
      stepwise > 0.6 ? 'mostly stepwise' : stepwise > 0.3 ? 'steps and leaps' : 'mostly leaps'
    }`;
  }

  const offBeat = notes.filter((n) => n.tick % beat !== 0).length / Math.max(1, notes.length);
  const density = notes.length / bars;
  const rhythm = `About ${Math.round(density)} notes per bar, ${
    offBeat > 0.5 ? 'many off the beat' : offBeat > 0.2 ? 'some off the beat' : 'mostly on the beat'
  }`;

  // Harmony: how many pitches usually sound together.
  const starts = new Map<number, number>();
  for (const n of pitchedNotes) starts.set(n.tick, (starts.get(n.tick) ?? 0) + 1);
  const together = mean([...starts.values()]);
  const harmony = !pitchedNotes.length
    ? undefined
    : together >= 2.5
      ? 'Block chords (3 or more notes together)'
      : together >= 1.5
        ? 'Dyads and some chords'
        : 'Mostly single lines; harmony is implied';

  const velocities = notes.map((n) => n.velocity);
  const vMean = mean(velocities);
  const vMin = velocities.reduce((m, v) => Math.min(m, v), 127);
  const vMax = velocities.reduce((m, v) => Math.max(m, v), 0);
  const dynamics =
    vMax - vMin <= 10
      ? `Steady ${dynamicsWord(vMean)}`
      : `${dynamicsWord(vMin)} to ${dynamicsWord(vMax)}, mostly ${dynamicsWord(vMean)}`;

  // Articulation: note length against the gap to the next note in the same part.
  const ratios: number[] = [];
  for (const p of pitched) {
    for (let i = 0; i + 1 < p.notes.length; i++) {
      const gap = p.notes[i + 1]!.tick - p.notes[i]!.tick;
      if (gap > 0) ratios.push(Math.min(1.5, p.notes[i]!.duration / gap));
    }
  }
  const legato = mean(ratios);
  const articulation = !ratios.length
    ? undefined
    : legato < 0.55
      ? 'Mostly staccato'
      : legato < 0.9
        ? 'Detached, medium note lengths'
        : 'Mostly legato';

  const texture = (() => {
    const layers = selected.length;
    const maxPoly = pitched.reduce((m, p) => Math.max(m, p.part.maxPolyphony), 0);
    if (layers === 1 && maxPoly <= 1) return 'One line';
    return `${layers} ${layers === 1 ? 'part' : 'parts'}, up to ${maxPoly} notes at once in a part`;
  })();

  // Accents: louder on the first beat of the bar than elsewhere?
  const strong = notes.filter((n) => n.tick % tpb === 0).map((n) => n.velocity);
  const weak = notes.filter((n) => n.tick % tpb !== 0).map((n) => n.velocity);
  const accentuation =
    strong.length && weak.length && mean(strong) - mean(weak) > 8
      ? 'First beat of the bar is stressed'
      : vMax - vMin > 25
        ? 'Accents vary from note to note'
        : 'Even, few accents';

  const short = pitchedNotes.filter((n) => n.duration < file.ppq / 8).length;
  const ornamentation =
    pitchedNotes.length && short / pitchedNotes.length > 0.1
      ? 'Many very short notes (grace notes or fast runs)'
      : 'Few or none';

  const sounds = [...new Set(selected.map((p) => (p.part.isDrums ? 'drums' : p.part.programName)))];
  const form = opts.form?.length
    ? opts.form
        .map((s) => `${s.label} (${s.bars})`)
        .join(' ')
        .slice(0, 400)
    : `${a.bars} bars`;

  const key = a.key
    ? `${a.key.tonic} ${a.key.mode}${a.key.source === 'detected' ? ' (detected)' : ''}`
    : undefined;
  const tempoText = `${Math.round(a.bpm)} BPM${a.tempoChanges ? `, changes ${a.tempoChanges} time(s)` : ''}`;

  return {
    ...(melody ? { melody: melody.slice(0, 500) } : {}),
    rhythm,
    meter: `${a.timeSignature.numerator}/${a.timeSignature.denominator}`,
    tempo: tempoText,
    ...(harmony ? { harmony } : {}),
    ...(key ? { key } : {}),
    dynamics,
    ...(articulation ? { articulation } : {}),
    timbre: sounds.join(', ').slice(0, 500),
    texture,
    form,
    style: MIDI_TYPE_LABELS[opts.type ?? a.classification.type],
    accentuation,
    ornamentation,
  };
}
