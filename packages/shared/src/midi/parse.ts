// Standard MIDI File (SMF) parser for untrusted uploads.
//
// Written from the spec instead of using a library so that every limit is explicit:
// the input is a user upload, so it is bounds-checked byte by byte and capped in size and note count.
// Supports format 0 and 1 with PPQ timing (what DAWs and notation programs export).

export const MAX_MIDI_BYTES = 2 * 1024 * 1024;
export const MAX_MIDI_TRACKS = 128;
export const MAX_MIDI_NOTES = 100_000;

export class MidiError extends Error {}

export interface MidiNote {
  /** Start in ticks. */
  tick: number;
  /** Length in ticks (at least 1). */
  duration: number;
  /** MIDI note number 0–127 (60 = middle C = c4 in Strudel). */
  pitch: number;
  /** 1–127 */
  velocity: number;
  /** 0–15 (9 = General MIDI drums). */
  channel: number;
}

export interface MidiTrack {
  /** Position of the MTrk chunk in the file. */
  index: number;
  name: string;
  /** Instrument name meta event, if any. */
  instrumentName: string;
  notes: MidiNote[];
  /** First program change per channel in this track, with its tick. */
  programs: { channel: number; program: number; tick: number }[];
}

export interface MidiFile {
  format: 0 | 1;
  /** Ticks per quarter note. */
  ppq: number;
  tracks: MidiTrack[];
  /** Tempo changes in BPM (quarter notes per minute), sorted by tick. */
  tempos: { tick: number; bpm: number }[];
  timeSignatures: { tick: number; numerator: number; denominator: number }[];
  /** sf: -7..7 (flats negative), minor: true for minor keys. */
  keySignatures: { tick: number; sf: number; minor: boolean }[];
  /** Tick of the last event in any track. */
  endTick: number;
}

class Reader {
  pos = 0;
  constructor(
    private readonly bytes: Uint8Array,
    private readonly end = bytes.length,
  ) {}
  get done() {
    return this.pos >= this.end;
  }
  need(n: number) {
    if (this.pos + n > this.end) throw new MidiError('The MIDI file is truncated');
  }
  u8() {
    this.need(1);
    return this.bytes[this.pos++]!;
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  u32() {
    return ((this.u8() << 24) >>> 0) + (this.u8() << 16) + (this.u8() << 8) + this.u8();
  }
  ascii(n: number) {
    this.need(n);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.bytes[this.pos++]!);
    return s;
  }
  slice(n: number) {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** Variable-length quantity: at most 4 bytes (max 0x0FFFFFFF). */
  vlq() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      value = (value << 7) | (b & 0x7f);
      if (!(b & 0x80)) return value;
    }
    throw new MidiError('Invalid MIDI data (bad variable-length number)');
  }
}

/** Text from meta events: decoded as Latin-1, control characters removed, trimmed, at most 64 chars. */
function cleanText(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

export function isMidiFile(bytes: Uint8Array): boolean {
  return bytes.length >= 14 && String.fromCharCode(...bytes.subarray(0, 4)) === 'MThd';
}

export function parseMidi(bytes: Uint8Array): MidiFile {
  if (bytes.length > MAX_MIDI_BYTES) throw new MidiError('The MIDI file is too large (max 2 MB)');
  if (!isMidiFile(bytes)) throw new MidiError('This is not a MIDI file');

  const r = new Reader(bytes);
  r.ascii(4);
  const headerLength = r.u32();
  if (headerLength < 6) throw new MidiError('Invalid MIDI header');
  const format = r.u16();
  const trackCount = r.u16();
  const division = r.u16();
  r.slice(headerLength - 6);

  if (format === 2) throw new MidiError('MIDI format 2 (independent sequences) is not supported');
  if (format !== 0 && format !== 1) throw new MidiError(`Unknown MIDI format ${format}`);
  if (division & 0x8000) throw new MidiError('MIDI files with SMPTE timing are not supported');
  const ppq = division;
  if (ppq <= 0) throw new MidiError('Invalid MIDI timing (0 ticks per quarter note)');
  if (trackCount > MAX_MIDI_TRACKS) throw new MidiError(`Too many tracks (max ${MAX_MIDI_TRACKS})`);

  const file: MidiFile = {
    format,
    ppq,
    tracks: [],
    tempos: [],
    timeSignatures: [],
    keySignatures: [],
    endTick: 0,
  };
  let noteCount = 0;

  while (!r.done && file.tracks.length < trackCount) {
    if (r.pos + 8 > bytes.length) break;
    const id = r.ascii(4);
    const length = r.u32();
    if (id !== 'MTrk') {
      // Unknown chunks must be skipped (spec), but they still have to fit in the file.
      r.slice(length);
      continue;
    }
    r.need(length);
    const end = r.pos + length;
    const t = new Reader(bytes, end);
    t.pos = r.pos;
    r.pos = end;

    const track: MidiTrack = {
      index: file.tracks.length,
      name: '',
      instrumentName: '',
      notes: [],
      programs: [],
    };
    // Open notes per channel*128+pitch, FIFO so overlapping repeats of the same key pair up in order.
    const open = new Map<number, { tick: number; velocity: number }[]>();
    let tick = 0;
    let status = 0;

    const closeNote = (channel: number, pitch: number, at: number) => {
      const key = channel * 128 + pitch;
      const started = open.get(key)?.shift();
      if (!started) return;
      if (++noteCount > MAX_MIDI_NOTES) throw new MidiError(`Too many notes (max ${MAX_MIDI_NOTES})`);
      track.notes.push({
        tick: started.tick,
        duration: Math.max(1, at - started.tick),
        pitch,
        velocity: started.velocity,
        channel,
      });
    };

    while (!t.done) {
      tick += t.vlq();
      if (tick > 0x7fffffff) throw new MidiError('Invalid MIDI data (song too long)');
      let byte = t.u8();

      if (byte === 0xff) {
        const type = t.u8();
        const data = t.slice(t.vlq());
        if (type === 0x2f) break; // end of track
        if (type === 0x03 && !track.name) track.name = cleanText(data);
        else if (type === 0x04 && !track.instrumentName) track.instrumentName = cleanText(data);
        else if (type === 0x51 && data.length === 3) {
          const usPerQuarter = (data[0]! << 16) | (data[1]! << 8) | data[2]!;
          if (usPerQuarter > 0) file.tempos.push({ tick, bpm: 60_000_000 / usPerQuarter });
        } else if (type === 0x58 && data.length >= 2) {
          const denominator = 2 ** data[1]!;
          if (data[0]! > 0 && denominator <= 64)
            file.timeSignatures.push({ tick, numerator: data[0]!, denominator });
        } else if (type === 0x59 && data.length === 2) {
          const sf = (data[0]! << 24) >> 24; // signed byte
          if (sf >= -7 && sf <= 7) file.keySignatures.push({ tick, sf, minor: data[1] === 1 });
        }
        status = 0;
        continue;
      }
      if (byte === 0xf0 || byte === 0xf7) {
        t.slice(t.vlq()); // sysex: skipped
        status = 0;
        continue;
      }
      if (byte & 0x80) {
        status = byte;
        byte = t.u8();
      } else if (!status) {
        throw new MidiError('Invalid MIDI data (running status without a status byte)');
      }

      const kind = status & 0xf0;
      const channel = status & 0x0f;
      const data1 = byte & 0x7f;
      if (kind === 0x80 || kind === 0x90) {
        const velocity = t.u8() & 0x7f;
        if (kind === 0x90 && velocity > 0) {
          const key = channel * 128 + data1;
          const list = open.get(key) ?? [];
          if (list.length >= 32) throw new MidiError('Invalid MIDI data (too many stuck notes)');
          list.push({ tick, velocity });
          open.set(key, list);
        } else {
          closeNote(channel, data1, tick);
        }
      } else if (kind === 0xc0) {
        if (!track.programs.some((p) => p.channel === channel))
          track.programs.push({ channel, program: data1, tick });
      } else if (kind === 0xd0) {
        // channel pressure: 1 data byte, already read
      } else {
        t.u8(); // 0xA0 aftertouch, 0xB0 control change, 0xE0 pitch bend: 2 data bytes
      }
    }

    // Notes that were never released end with the track.
    for (const [key, list] of open) {
      while (list.length) closeNote(Math.floor(key / 128), key % 128, Math.max(tick, list[0]!.tick + 1));
    }
    track.notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    file.endTick = Math.max(file.endTick, tick);
    for (const n of track.notes) file.endTick = Math.max(file.endTick, n.tick + n.duration);
    file.tracks.push(track);
  }

  if (!file.tracks.length) throw new MidiError('The MIDI file has no tracks');
  const byTick = <T extends { tick: number }>(a: T, b: T) => a.tick - b.tick;
  file.tempos.sort(byTick);
  file.timeSignatures.sort(byTick);
  file.keySignatures.sort(byTick);
  return file;
}
