// A song is plain Strudel code. Tracks are its top-level labeled patterns, exactly like on strudel.cc:
//
//   setcpm(100/4)                      <- header (anything that is not a labeled pattern)
//   drums: s("bd sd").bank("RolandTR909")
//   _bass: note("c2").s("gm_acoustic_bass")    <- "_" prefix: muted (Strudel built-in)
//   Skeys: note("c3").s("gm_piano")             <- "S" prefix: solo (Strudel built-in)
//
// These helpers read the tracks from the code and make small text edits (mute, solo, instrument, rename,
// add, remove) so the mixer UI and the code editor always show the same thing.
import { parse, type Node } from 'acorn';

export interface TrackInfo {
  /** Position among the tracks (0-based). */
  index: number;
  /** Label as written, including prefixes, e.g. "_bass". */
  label: string;
  /** Label without mute/solo prefixes, e.g. "bass". "$" for anonymous tracks. */
  name: string;
  muted: boolean;
  solo: boolean;
  /** Sound set with .s("...") / .sound("...") (outermost call), if it is a single sound name. */
  instrument: string | null;
  /** Drum machine set with .bank("..."), if any. */
  bank: string | null;
  /** The pattern code after the label. */
  body: string;
  /** Character ranges in the song code. */
  range: [number, number];
  labelRange: [number, number];
  bodyRange: [number, number];
  instrumentRange: [number, number] | null;
  bankRange: [number, number] | null;
}

export type ParseResult = { ok: true; tracks: TrackInfo[] } | { ok: false; error: string; tracks: [] };

type AnyNode = Node & Record<string, unknown>;

const SOUND_METHODS = new Set(['s', 'sound']);
const SINGLE_SOUND = /^[A-Za-z0-9_:.-]+$/;

function stringLiteral(node: AnyNode | undefined): { value: string; range: [number, number] } | null {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return { value: node.value, range: [node.start, node.end] };
  }
  if (node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0) {
    const quasi = (node.quasis as AnyNode[])[0] as AnyNode & { value: { cooked: string } };
    return { value: quasi.value.cooked, range: [node.start, node.end] };
  }
  return null;
}

/** Walks a method chain from the outside in (last call first) to find .s() and .bank(). */
function findSoundCalls(expr: AnyNode) {
  let instrument: { value: string; range: [number, number] } | null = null;
  let bank: { value: string; range: [number, number] } | null = null;
  let node: AnyNode | undefined = expr;
  while (node && node.type === 'CallExpression') {
    const callee = node.callee as AnyNode;
    const args = node.arguments as AnyNode[];
    let name: string | null = null;
    if (callee.type === 'MemberExpression' && !callee.computed) {
      name = (callee.property as AnyNode).name as string;
    } else if (callee.type === 'Identifier') {
      name = callee.name as string;
    }
    if (name && SOUND_METHODS.has(name) && !instrument) {
      const lit = stringLiteral(args[0]);
      if (lit && SINGLE_SOUND.test(lit.value.trim())) instrument = lit;
    }
    if (name === 'bank' && !bank) bank = stringLiteral(args[0]);
    node = callee.type === 'MemberExpression' ? (callee.object as AnyNode) : undefined;
  }
  return { instrument, bank };
}

export function parseTracks(code: string): ParseResult {
  let ast: AnyNode;
  try {
    ast = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as AnyNode;
  } catch (err) {
    return { ok: false, error: (err as Error).message, tracks: [] };
  }

  const tracks: TrackInfo[] = [];
  for (const stmt of ast.body as AnyNode[]) {
    if (stmt.type !== 'LabeledStatement') continue;
    const body = stmt.body as AnyNode;
    if (body.type !== 'ExpressionStatement') continue;
    const label = (stmt.label as AnyNode).name as string;
    const expr = body.expression as AnyNode;
    const muted = label.startsWith('_') || label.endsWith('_');
    const bare = label.replace(/^_+|_+$/g, '');
    // Strudel treats any key longer than one character that starts with "S" as solo.
    const solo = bare.length > 1 && bare.startsWith('S');
    const name = solo ? bare.slice(1) : bare;
    const { instrument, bank } = findSoundCalls(expr);
    const labelNode = stmt.label as AnyNode;
    tracks.push({
      index: tracks.length,
      label,
      name: name || '$',
      muted,
      solo,
      instrument: instrument?.value.trim() ?? null,
      bank: bank?.value ?? null,
      body: code.slice(expr.start, expr.end),
      range: [stmt.start, stmt.end],
      labelRange: [labelNode.start, labelNode.end],
      bodyRange: [expr.start, expr.end],
      instrumentRange: instrument?.range ?? null,
      bankRange: bank?.range ?? null,
    });
  }
  return { ok: true, tracks };
}

const RESERVED = new Set(
  'break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static enum await implements package protected interface private public'.split(
    ' ',
  ),
);

/** Turns a user-typed name into a valid lowercase track label: "Lead Synth!" -> "lead_synth". */
export function sanitizeTrackName(input: string): string {
  let s = input
    // Letters that do not decompose into base letter + accent.
    .replace(/[łŁ]/g, 'l')
    .replace(/[øØ]/g, 'o')
    .replace(/[đĐ]/g, 'd')
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, 'ae')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  if (!s) s = 'track';
  if (/^[0-9]/.test(s)) s = `t${s}`;
  if (RESERVED.has(s)) s = `${s}_track`;
  return s;
}

function uniqueName(code: string, wanted: string, exceptIndex = -1): string {
  const parsed = parseTracks(code);
  const taken = new Set(parsed.tracks.filter((t) => t.index !== exceptIndex).map((t) => t.name));
  let name = wanted;
  for (let i = 2; taken.has(name); i++) name = `${wanted}_${i}`;
  return name;
}

function replaceRange(code: string, [from, to]: [number, number], text: string): string {
  return code.slice(0, from) + text + code.slice(to);
}

function getTrack(code: string, index: number): TrackInfo {
  const parsed = parseTracks(code);
  if (!parsed.ok) throw new Error(`Cannot edit tracks: the code has a syntax error (${parsed.error})`);
  const track = parsed.tracks[index];
  if (!track) throw new Error(`No track #${index}`);
  return track;
}

function labelFor(name: string, muted: boolean, solo: boolean): string {
  return `${muted ? '_' : ''}${solo ? 'S' : ''}${name}`;
}

export function setTrackMuted(code: string, index: number, muted: boolean): string {
  const t = getTrack(code, index);
  return replaceRange(code, t.labelRange, labelFor(t.name, muted, t.solo));
}

export function setTrackSolo(code: string, index: number, solo: boolean): string {
  const t = getTrack(code, index);
  return replaceRange(code, t.labelRange, labelFor(t.name, t.muted, solo));
}

export function renameTrack(code: string, index: number, newName: string): string {
  const t = getTrack(code, index);
  const name = uniqueName(code, sanitizeTrackName(newName), index);
  return replaceRange(code, t.labelRange, labelFor(name, t.muted, t.solo));
}

/** Sets the sound of a track: replaces the existing .s("...") value or appends .s("...") to the pattern. */
export function setTrackInstrument(code: string, index: number, instrument: string): string {
  if (!SINGLE_SOUND.test(instrument)) throw new Error('Invalid instrument name');
  const t = getTrack(code, index);
  if (t.instrumentRange) return replaceRange(code, t.instrumentRange, JSON.stringify(instrument));
  return replaceRange(code, [t.bodyRange[1], t.bodyRange[1]], `.s(${JSON.stringify(instrument)})`);
}

/** Sets the drum machine of a track: replaces .bank("...") or appends it. */
export function setTrackBank(code: string, index: number, bank: string): string {
  if (!SINGLE_SOUND.test(bank)) throw new Error('Invalid bank name');
  const t = getTrack(code, index);
  if (t.bankRange) return replaceRange(code, t.bankRange, JSON.stringify(bank));
  return replaceRange(code, [t.bodyRange[1], t.bodyRange[1]], `.bank(${JSON.stringify(bank)})`);
}

/** Removes a track and the blank line that separated it from the next one. */
export function removeTrack(code: string, index: number): string {
  const t = getTrack(code, index);
  const from = t.range[0];
  let to = t.range[1];
  while (to < code.length && (code[to] === ' ' || code[to] === '\t')) to++;
  if (code[to] === '\n') to++;
  if (code[to] === '\n' && (from === 0 || code[from - 1] === '\n')) to++;
  return code.slice(0, from) + code.slice(to);
}

/** Appends a new track at the end of the song. Returns the new code. */
export function addTrack(code: string, name: string, body: string): string {
  const label = uniqueName(code, sanitizeTrackName(name));
  const base = code.replace(/\s*$/, '');
  return `${base}${base ? '\n\n' : ''}${label}: ${body.trim()}\n`;
}

export const NEW_SONG_CODE = `setcpm(100/4)

drums: s("bd ~ sd ~, hh*8").bank("RolandTR909")

bass: note("<c2 c2 a1 g1>").s("gm_electric_bass_finger")

keys: note("<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>").s("gm_epiano1").gain(.6)
`;
