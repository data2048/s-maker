// Strudel accepts any text as a note when the code runs and fails only when the note plays.

const NOTE_NAME = /^[a-gA-G][#bsf]*-?\d*$/;

export function isValidNote(note: unknown): boolean {
  if (typeof note === 'number') return Number.isFinite(note);
  return typeof note === 'string' && NOTE_NAME.test(note);
}
