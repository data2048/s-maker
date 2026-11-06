// Music Brief: what a song is, in the 14 musical elements. Filled in from a MIDI analysis or by hand,
// and read by the agent on every call.
import { z } from 'zod';

export const MUSIC_ELEMENTS = [
  'melody',
  'rhythm',
  'meter',
  'tempo',
  'harmony',
  'key',
  'dynamics',
  'articulation',
  'timbre',
  'texture',
  'form',
  'style',
  'accentuation',
  'ornamentation',
] as const;
export type MusicElement = (typeof MUSIC_ELEMENTS)[number];

export const MUSIC_ELEMENT_HINTS: Record<MusicElement, string> = {
  melody: 'Range, contour, main motif',
  rhythm: 'Note values, grooves, syncopation',
  meter: 'Time signature',
  tempo: 'BPM and character',
  harmony: 'Chords and progressions',
  key: 'Tonic and mode',
  dynamics: 'Loudness and how it changes',
  articulation: 'Legato, staccato, note lengths',
  timbre: 'Instruments and sound design',
  texture: 'Layers and how they relate',
  form: 'Sections and their order',
  style: 'Genre and references',
  accentuation: 'Which notes are stressed',
  ornamentation: 'Grace notes, trills, fills',
};

export const MAX_BRIEF_ELEMENT_LENGTH = 500;

const elementText = z.string().trim().max(MAX_BRIEF_ELEMENT_LENGTH);

export const musicBriefSchema = z.object(
  Object.fromEntries(MUSIC_ELEMENTS.map((e) => [e, elementText.optional()])) as Record<
    MusicElement,
    z.ZodOptional<typeof elementText>
  >,
);
export type MusicBrief = z.infer<typeof musicBriefSchema>;

export const isBriefEmpty = (b: MusicBrief | null | undefined) => !b || MUSIC_ELEMENTS.every((e) => !b[e]);
