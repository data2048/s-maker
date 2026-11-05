// Minimal Standard MIDI File writer (format 1). Used to generate test fixtures, later for MIDI export.

export interface WriteNote {
  tick: number;
  duration: number;
  pitch: number;
  velocity?: number;
}

export interface WriteTrack {
  name?: string;
  channel?: number;
  program?: number;
  notes: WriteNote[];
}

export interface WriteSpec {
  ppq?: number;
  bpm?: number;
  timeSignature?: [number, number];
  /** sf: -7..7, minor */
  key?: { sf: number; minor: boolean };
  tracks: WriteTrack[];
}

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const text = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function chunk(events: { tick: number; order: number; bytes: number[] }[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data: number[] = [];
  let last = 0;
  for (const e of events) {
    data.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  data.push(0, 0xff, 0x2f, 0);
  return [...text('MTrk'), ...u32(data.length), ...data];
}

export function writeMidi(spec: WriteSpec): Uint8Array {
  const ppq = spec.ppq ?? 480;
  const [num, den] = spec.timeSignature ?? [4, 4];
  const conductor: { tick: number; order: number; bytes: number[] }[] = [];
  const us = Math.round(60_000_000 / (spec.bpm ?? 120));
  conductor.push({
    tick: 0,
    order: 0,
    bytes: [0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff],
  });
  conductor.push({ tick: 0, order: 0, bytes: [0xff, 0x58, 4, num, Math.log2(den), 24, 8] });
  if (spec.key)
    conductor.push({ tick: 0, order: 0, bytes: [0xff, 0x59, 2, spec.key.sf & 0xff, spec.key.minor ? 1 : 0] });

  const chunks = [chunk(conductor)];
  for (const t of spec.tracks) {
    const ch = t.channel ?? 0;
    const events: { tick: number; order: number; bytes: number[] }[] = [];
    if (t.name) {
      const name = text(t.name);
      events.push({ tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(name.length), ...name] });
    }
    if (t.program !== undefined) events.push({ tick: 0, order: 1, bytes: [0xc0 | ch, t.program] });
    for (const n of t.notes) {
      // note-offs sort before note-ons at the same tick
      events.push({ tick: n.tick, order: 3, bytes: [0x90 | ch, n.pitch, n.velocity ?? 100] });
      events.push({ tick: n.tick + n.duration, order: 2, bytes: [0x80 | ch, n.pitch, 0] });
    }
    chunks.push(chunk(events));
  }
  const header = [...text('MThd'), ...u32(6), 0, 1, 0, chunks.length, (ppq >> 8) & 0xff, ppq & 0xff];
  return Uint8Array.from([...header, ...chunks.flat()]);
}
