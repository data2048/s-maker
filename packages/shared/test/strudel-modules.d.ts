// Strudel ships no types; the round-trip tests only need these few functions.
declare module '@strudel/transpiler' {
  export function evaluate(code: string): Promise<{ pattern: unknown }>;
}
declare module '@strudel/core' {
  export function evalScope(...modules: unknown[]): Promise<unknown>;
  export function noteToMidi(note: string): number;
}
declare module '@strudel/mini';
