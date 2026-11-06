// API types for MIDI uploads and imports.
import { z } from 'zod';
import { songTitleSchema, VISIBILITIES, type SongDto } from '../songs';
import type { MidiAnalysis } from './analyze';
import { MIDI_TYPES, type MidiType } from './classify';
import type { FormSection } from './essence';
import { GRIDS, MAX_IMPORT_BARS, type ConversionResult } from './faithful';

export const IMPORT_MODES = ['faithful', 'essence'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

export const midiConvertOptionsSchema = z.object({
  mode: z.enum(IMPORT_MODES).default('faithful'),
  parts: z.array(z.number().int().min(0).max(4096)).min(1, 'Choose at least one track').max(256),
  grid: z.union([z.literal('auto'), z.literal(GRIDS)]).default('auto'),
  startBar: z.number().int().min(0).max(100_000).default(0),
  bars: z.number().int().min(1).max(MAX_IMPORT_BARS).optional(),
  velocity: z.boolean().default(true),
});
export type MidiConvertOptions = z.input<typeof midiConvertOptionsSchema>;

export const midiImportRequestSchema = midiConvertOptionsSchema.extend({
  title: songTitleSchema,
  visibility: z.enum(VISIBILITIES).default('group'),
  /** The user's correction of the detected type. */
  midiType: z.enum(MIDI_TYPES).optional(),
});
export type MidiImportRequest = z.input<typeof midiImportRequestSchema>;

export interface MidiUploadDto {
  id: number;
  fileName: string;
  size: number;
  createdAt: string;
  analysis: MidiAnalysis;
}

export type MidiConvertResponse = ConversionResult & {
  mode: ImportMode;
  /** Essence mode: the detected sections. */
  form?: FormSection[];
  /** Essence mode: notes kept in the patterns. */
  keptNotes?: number;
};

export type { MidiType };

export interface MidiImportResponse {
  song: SongDto;
  warnings: string[];
}

/** File names from uploads: shown in the UI and in code comments, so only harmless characters. */
export function cleanMidiFileName(raw: string): string {
  const name = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 100);
  return name || 'upload.mid';
}
