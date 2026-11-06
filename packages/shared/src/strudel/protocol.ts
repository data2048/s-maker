// Messages between the app page and the sandboxed Strudel player iframe (window.postMessage).
// Both sides validate everything they receive: the other side is a different, untrusted context.
import { z } from 'zod';
import { EXPORT_FORMATS, MAX_EXPORT_BARS, midiExportSchema } from './export';
import { MAX_CODE_LENGTH } from './validate';

const code = z.string().max(MAX_CODE_LENGTH);

export const EDITOR_FONT_MIN = 10;
export const EDITOR_FONT_MAX = 32;

/** Editor preferences. Stored by the app (the sandbox has no persistent storage). */
export const editorSettingsSchema = z.object({
  fontSize: z.number().int().min(EDITOR_FONT_MIN).max(EDITOR_FONT_MAX),
  lineWrap: z.boolean(),
});
export type EditorSettings = z.infer<typeof editorSettingsSchema>;
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { fontSize: 15, lineWrap: false };

/** App → sandbox */
export const toSandboxSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setCode'), code }),
  z.object({ type: z.literal('play') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('settings'), settings: editorSettingsSchema }),
  /** Try code without playing it: does it evaluate, and do its sounds exist? */
  z.object({ type: z.literal('check'), id: z.number().int(), code }),
  /** Turn the code into a file. The player cannot download anything, so it sends the result back. */
  z.object({
    type: z.literal('export'),
    id: z.number().int(),
    code,
    format: z.enum(EXPORT_FORMATS),
    bars: z.number().int().min(1).max(MAX_EXPORT_BARS),
  }),
]);
export type ToSandbox = z.infer<typeof toSandboxSchema>;

/** Sandbox → app */
export const fromSandboxSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('code'), code }),
  z.object({
    type: z.literal('state'),
    started: z.boolean(),
    pending: z.boolean(),
    error: z.string().max(2000).nullable(),
  }),
  /** Keyboard shortcut pressed in the player that the app handles (Ctrl+S = save). */
  z.object({ type: z.literal('command'), command: z.enum(['save']) }),
  /** The user changed a preference in the player toolbar; the app saves it. */
  z.object({ type: z.literal('settings'), settings: editorSettingsSchema }),
  z.object({ type: z.literal('checked'), id: z.number().int(), error: z.string().max(2000).nullable() }),
  z.object({
    type: z.literal('exportProgress'),
    id: z.number().int(),
    stage: z.enum(['sounds', 'render', 'encode']),
  }),
  z.object({
    type: z.literal('exported'),
    id: z.number().int(),
    error: z.string().max(2000).nullable(),
    /** A WAV or MP3 file. The app checks it before offering it. */
    bytes: z.custom<ArrayBuffer>((v) => v instanceof ArrayBuffer).optional(),
    midi: midiExportSchema.optional(),
  }),
]);
export type FromSandbox = z.infer<typeof fromSandboxSchema>;

export const SANDBOX_PATH = '/sandbox.html';
