// Messages between the app page and the sandboxed Strudel player iframe (window.postMessage).
// Both sides validate everything they receive: the other side is a different, untrusted context.
import { z } from 'zod';
import { MAX_CODE_LENGTH } from './validate';

const code = z.string().max(MAX_CODE_LENGTH);

/** App → sandbox */
export const toSandboxSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setCode'), code, readOnly: z.boolean().optional() }),
  z.object({ type: z.literal('play') }),
  z.object({ type: z.literal('stop') }),
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
]);
export type FromSandbox = z.infer<typeof fromSandboxSchema>;

export const SANDBOX_PATH = '/sandbox.html';
