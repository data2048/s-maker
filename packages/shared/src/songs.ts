import { z } from 'zod';
import { MAX_CODE_LENGTH } from './strudel/validate';

export const VISIBILITIES = ['group', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const songTitleSchema = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(100, 'Title can have at most 100 characters')
  .regex(/^[^\p{Cc}]+$/u, 'Title contains invalid characters');

const songCodeSchema = z.string().max(MAX_CODE_LENGTH, `Code can have at most ${MAX_CODE_LENGTH} characters`);
const messageSchema = z.string().trim().max(200).optional();

export const createSongRequestSchema = z.object({
  title: songTitleSchema,
  code: songCodeSchema.optional(),
  visibility: z.enum(VISIBILITIES).default('group'),
});
export type CreateSongRequest = z.input<typeof createSongRequestSchema>;

export const updateSongRequestSchema = z
  .object({
    title: songTitleSchema.optional(),
    visibility: z.enum(VISIBILITIES).optional(),
  })
  .refine((v) => v.title !== undefined || v.visibility !== undefined, 'Nothing to update');

export const saveVersionRequestSchema = z.object({
  code: songCodeSchema,
  message: messageSchema,
  /** Version the edit started from; saving fails with 409 if someone saved in the meantime. */
  baseVersionId: z.number().int().positive(),
});
export type SaveVersionRequest = z.infer<typeof saveVersionRequestSchema>;

export const forkSongRequestSchema = z.object({
  versionId: z.number().int().positive().optional(),
  title: songTitleSchema.optional(),
});

export interface UserRefDto {
  id: number;
  username: string;
  displayName: string;
}

export interface SongSummaryDto {
  id: number;
  title: string;
  owner: UserRefDto;
  visibility: Visibility;
  versionCount: number;
  forkedFrom: { songId: number; title: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface VersionSummaryDto {
  id: number;
  number: number;
  author: UserRefDto | null;
  authorKind: 'user' | 'agent';
  message: string | null;
  createdAt: string;
}

export interface VersionDto extends VersionSummaryDto {
  code: string;
}

export interface SongDto extends SongSummaryDto {
  currentVersion: VersionDto;
  canEdit: boolean;
}
