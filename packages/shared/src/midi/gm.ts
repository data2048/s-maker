// General MIDI → Strudel sounds.
import { GM_SOUNDS, type GmSound } from '../strudel/instruments';

export const GM_DRUM_CHANNEL = 9;

/**
 * Program number (0–127) → Strudel gm_* soundfont. Strudel merges the four acoustic/electric grand
 * pianos (programs 0–3) into gm_piano; every other program has its own sound in GM order.
 */
export function gmSoundForProgram(program: number): GmSound {
  const p = Math.min(127, Math.max(0, Math.trunc(program)));
  return GM_SOUNDS[p < 4 ? 0 : p - 3]!;
}

/** Names of the 128 GM programs (for display). */
export function gmProgramName(program: number): string {
  if (program < 4)
    return ['Acoustic grand piano', 'Bright piano', 'Electric grand piano', 'Honky-tonk piano'][program]!;
  const s = gmSoundForProgram(program).replace(/^gm_/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Drum sounds every common Strudel drum machine bank has. */
export const DRUM_SOUNDS = ['bd', 'sd', 'rim', 'cp', 'hh', 'oh', 'lt', 'mt', 'ht', 'cr', 'rd'] as const;
export type DrumSound = (typeof DRUM_SOUNDS)[number];

const DRUMS: Record<number, DrumSound> = {
  35: 'bd',
  36: 'bd',
  37: 'rim',
  38: 'sd',
  39: 'cp',
  40: 'sd',
  41: 'lt',
  43: 'lt',
  45: 'mt',
  47: 'mt',
  48: 'ht',
  50: 'ht',
  42: 'hh',
  44: 'hh',
  46: 'oh',
  49: 'cr',
  52: 'cr',
  55: 'cr',
  57: 'cr',
  51: 'rd',
  53: 'rd',
  59: 'rd',
};

/** GM drum key (channel 10) → drum sound. Keys without a close match (cowbell, congas…) are approximated. */
export function drumSoundForKey(key: number): { sound: DrumSound; exact: boolean } {
  const exact = DRUMS[key];
  if (exact) return { sound: exact, exact: true };
  if (key < 35) return { sound: 'bd', exact: false };
  // Shakers, tambourine, cabasa, maracas → hi-hat; wood/metal hits → rim; low hand drums → toms.
  if ([54, 69, 70, 82].includes(key)) return { sound: 'hh', exact: false };
  if ([60, 61, 62, 63, 64, 65, 66].includes(key)) return { sound: key < 63 ? 'mt' : 'lt', exact: false };
  return { sound: 'rim', exact: false };
}
