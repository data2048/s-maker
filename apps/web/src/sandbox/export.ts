// Turning a song into a file, inside the sandbox. Based on renderPatternAudio from @strudel/webaudio
// (AGPL-3.0, Strudel contributors), which downloads the file itself; a sandboxed page cannot download.
import {
  beatsPerBar,
  encodeWav,
  eventsToMidi,
  MAX_EXPORT_SECONDS,
  parseTracks,
  toInt16,
  type ExportEvent,
  type ExportFormat,
  type MidiExport,
} from '@s-maker/shared';
import { stack } from '@strudel/core';
import { evaluate as evaluateCode } from '@strudel/transpiler';
import {
  getAudioContext,
  initAudio,
  resetGlobalEffects,
  setAudioContext,
  setSuperdoughAudioController,
  superdough,
} from '@strudel/webaudio';
import { SuperdoughAudioController } from 'superdough/superdoughoutput.mjs';

const SAMPLE_RATE = 44100;
/** Reverb and delay keep sounding after the last note. */
const TAIL_SECONDS = 2;
const MP3_KBPS = 192;
const MP3_FRAME = 1152;
/** Strudel's own default when a song does not set a tempo. */
const DEFAULT_CPS = 0.5;

interface Hap {
  whole: { begin: { valueOf(): number }; end: { valueOf(): number } } | null;
  duration: number;
  value: ExportEvent['value'];
  hasOnset(): boolean;
  ensureObjectValue(): void;
}
interface QueryPattern {
  queryArc(begin: number, end: number, controls?: object): Hap[];
}

/** Runs fn with the tempo functions replaced: exporting or checking must not change what is playing. */
export async function withTempoStub<T>(onTempo: (cps: number) => void, fn: () => Promise<T>): Promise<T> {
  const scope = globalThis as unknown as Record<string, unknown>;
  const saved = { setcpm: scope.setcpm, setcps: scope.setcps };
  scope.setcpm = (cpm: number) => onTempo(cpm / 60);
  scope.setcps = (cps: number) => onTempo(cps);
  try {
    return await fn();
  } finally {
    scope.setcpm = saved.setcpm;
    scope.setcps = saved.setcps;
  }
}

/** Every track that would be heard: muted ones are left out, and solo ones win, as in the player. */
async function evaluateSong(code: string) {
  const parsed = parseTracks(code);
  if (!parsed.ok) throw new Error(`Syntax error: ${parsed.error}`);
  const first = parsed.tracks[0];
  const header = first ? code.slice(0, first.range[0]) : '';
  const prefixed = (label: string, name: string, prefix: string) =>
    label !== name && label.startsWith(prefix);
  const soloed = parsed.tracks.filter((t) => prefixed(t.label, t.name, 'S'));
  const heard = soloed.length ? soloed : parsed.tracks.filter((t) => !prefixed(t.label, t.name, '_'));

  let cps = DEFAULT_CPS;
  const tracks = await withTempoStub(
    (v) => {
      if (v > 0) cps = v;
    },
    async () => {
      const out: { name: string; pattern: QueryPattern }[] = [];
      for (const t of heard) {
        const { pattern } = (await evaluateCode(`${header}\n${t.body}`)) as { pattern: QueryPattern };
        out.push({ name: t.name, pattern });
      }
      // A song without labels is one pattern.
      if (!parsed.tracks.length) {
        const { pattern } = (await evaluateCode(code)) as { pattern?: QueryPattern };
        if (pattern) out.push({ name: 'song', pattern });
      }
      return out;
    },
  );
  if (!tracks.length)
    throw new Error('There is nothing to export: all tracks are muted or the song is empty.');
  return { tracks, cps };
}

function checkLength(bars: number, cps: number): void {
  const seconds = bars / cps;
  if (seconds > MAX_EXPORT_SECONDS)
    throw new Error(
      `${bars} bars at this tempo take ${Math.round(seconds)} s. The limit is ${MAX_EXPORT_SECONDS} s.`,
    );
}

async function renderAudio(
  patterns: QueryPattern[],
  cps: number,
  bars: number,
  onStage: (stage: 'sounds' | 'render') => void,
): Promise<AudioBuffer> {
  const pattern = stack(...patterns) as unknown as QueryPattern;
  await getAudioContext().close();
  const context = new OfflineAudioContext(
    2,
    Math.ceil((bars / cps + TAIL_SECONDS) * SAMPLE_RATE),
    SAMPLE_RATE,
  );
  setAudioContext(context);
  setSuperdoughAudioController(new SuperdoughAudioController(context));
  try {
    await initAudio({});
    onStage('sounds');
    // In order of time: controls such as cut depend on what played before.
    const haps = pattern
      .queryArc(0, bars, { _cps: cps })
      .filter((h) => h.whole && h.hasOnset())
      .sort((a, b) => a.whole!.begin.valueOf() - b.whole!.begin.valueOf());
    for (const hap of haps) {
      hap.ensureObjectValue();
      const begin = hap.whole!.begin.valueOf() / cps;
      try {
        await superdough(hap.value, begin, hap.duration / cps, cps, begin);
      } catch (e) {
        console.warn('export: a sound failed', e);
      }
    }
    onStage('render');
    return await context.startRendering();
  } finally {
    setAudioContext(null);
    setSuperdoughAudioController(null);
    resetGlobalEffects();
    // Playing needs the audio effects again, on a new context.
    void initAudio({});
  }
}

function hasSound(buffer: AudioBuffer): boolean {
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    if (buffer.getChannelData(c).some((s) => Math.abs(s) > 1e-4)) return true;
  }
  return false;
}

/** Long encodes share the thread with the player's page, so let it breathe. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

async function encodeMp3(buffer: AudioBuffer): Promise<ArrayBuffer> {
  // Only loaded when somebody exports an MP3.
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const left = toInt16(buffer.getChannelData(0));
  const right = toInt16(buffer.getChannelData(1));
  const encoder = new Mp3Encoder(2, buffer.sampleRate, MP3_KBPS);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < left.length; i += MP3_FRAME) {
    const chunk = encoder.encodeBuffer(left.subarray(i, i + MP3_FRAME), right.subarray(i, i + MP3_FRAME));
    if (chunk.length) chunks.push(new Uint8Array(chunk));
    if (i % (MP3_FRAME * 256) === 0) await breathe();
  }
  const last = encoder.flush();
  if (last.length) chunks.push(new Uint8Array(last));
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

export async function exportAudio(
  code: string,
  format: Exclude<ExportFormat, 'midi'>,
  bars: number,
  onStage: (stage: 'sounds' | 'render' | 'encode') => void,
): Promise<ArrayBuffer> {
  const { tracks, cps } = await evaluateSong(code);
  checkLength(bars, cps);
  const buffer = await renderAudio(
    tracks.map((t) => t.pattern),
    cps,
    bars,
    onStage,
  );
  if (!hasSound(buffer))
    throw new Error('The result is silent. Check that the sounds can load, then try again.');
  onStage('encode');
  await breathe();
  if (format === 'mp3') return encodeMp3(buffer);
  return encodeWav([buffer.getChannelData(0), buffer.getChannelData(1)], buffer.sampleRate);
}

export async function exportMidi(code: string, bars: number): Promise<MidiExport> {
  const { tracks, cps } = await evaluateSong(code);
  return eventsToMidi({
    cyclesPerSecond: cps,
    beats: beatsPerBar(code),
    tracks: tracks.map((t) => ({
      name: t.name,
      events: t.pattern
        .queryArc(0, bars, { _cps: cps })
        .filter((h) => h.whole && h.hasOnset())
        .map((h) => {
          h.ensureObjectValue();
          return { begin: h.whole!.begin.valueOf(), end: h.whole!.end.valueOf(), value: h.value };
        }),
    })),
  });
}
