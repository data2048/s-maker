// Messages between the app page and the sandboxed Strudel player iframe (window.postMessage).
// Both sides validate everything they receive: the other side is a different, untrusted context.
import { z } from 'zod';
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
]);
export type FromSandbox = z.infer<typeof fromSandboxSchema>;

export const SANDBOX_PATH = '/sandbox.html';
