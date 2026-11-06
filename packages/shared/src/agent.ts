// The agent: request and answer formats, and applying its changes to song code.
import { z } from 'zod';
import { musicBriefSchema, type MusicBrief } from './brief';
import { addTrack, parseTracks, removeTrack, sanitizeTrackName, setTrackBody } from './strudel/tracks';
import { MAX_CODE_LENGTH } from './strudel/validate';

/** Songs longer than this are not sent to a model: the cost would be high and the result poor. */
export const MAX_AGENT_CODE_LENGTH = 60_000;
export const MAX_INSTRUCTION_LENGTH = 2000;
export const MAX_REPAIRS = 2;

export const MODEL_TIERS = ['fast', 'strong'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

const code = z.string().min(1).max(MAX_CODE_LENGTH);
const trackName = z.string().trim().min(1).max(40);

/** What a model may change. Everything is checked before the user sees it. */
export const agentChangeSchema = z.discriminatedUnion('type', [
  /** Replaces the pattern of an existing track. */
  z.object({ type: z.literal('track'), name: trackName, code }),
  z.object({ type: z.literal('add'), name: trackName, code }),
  z.object({ type: z.literal('remove'), name: trackName }),
  /** Replaces everything above the first track: setcpm and const declarations. */
  z.object({ type: z.literal('header'), code: z.string().max(MAX_CODE_LENGTH) }),
]);
export type AgentChange = z.infer<typeof agentChangeSchema>;

export const agentAnswerSchema = z.object({
  summary: z.string().trim().min(1).max(400),
  changes: z.array(agentChangeSchema).max(64),
  brief: musicBriefSchema.optional(),
});
export type AgentAnswer = z.infer<typeof agentAnswerSchema>;

/** Models tend to wrap JSON in a code fence or add a sentence around it. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1]! : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The answer is not a JSON object');
  return JSON.parse(candidate.slice(start, end + 1));
}

function trackIndex(songCode: string, name: string): number {
  const parsed = parseTracks(songCode);
  if (!parsed.ok) throw new Error(`The code has a syntax error: ${parsed.error}`);
  const wanted = name.replace(/^[_S](?=[a-z])/, '');
  const i = parsed.tracks.findIndex((t) => t.name === name || t.label === name || t.name === wanted);
  if (i < 0) {
    const known = parsed.tracks.map((t) => t.name).join(', ') || 'none';
    throw new Error(`There is no track "${name}". Tracks: ${known}`);
  }
  return i;
}

/** Models sometimes repeat the label: "bass: note(...)" for a track named bass. */
function withoutLabel(body: string, name: string): string {
  const escaped = name.replace(/[^a-z0-9_]/gi, '');
  return body.replace(new RegExp(`^\\s*[_S]?${escaped}\\s*:\\s*`), '').trim();
}

function replaceHeader(songCode: string, header: string): string {
  const parsed = parseTracks(songCode);
  if (!parsed.ok) throw new Error(`The code has a syntax error: ${parsed.error}`);
  const first = parsed.tracks[0];
  const rest = first ? songCode.slice(first.range[0]) : '';
  return `${header.trim()}${rest ? `\n\n${rest}` : '\n'}`;
}

/** Applies the changes in order. Throws an Error with a message the model can act on. */
export function applyAgentChanges(songCode: string, changes: AgentChange[]): string {
  let out = songCode;
  for (const c of changes) {
    if (c.type === 'track') out = setTrackBody(out, trackIndex(out, c.name), withoutLabel(c.code, c.name));
    else if (c.type === 'add')
      out = addTrack(out, sanitizeTrackName(c.name), withoutLabel(c.code, sanitizeTrackName(c.name)));
    else if (c.type === 'remove') out = removeTrack(out, trackIndex(out, c.name));
    else out = replaceHeader(out, c.code);
  }
  return out;
}

export const agentProposeRequestSchema = z.object({
  instruction: z.string().trim().min(1, 'Write what the agent should do').max(MAX_INSTRUCTION_LENGTH),
  /** Limit the change to this track. */
  track: trackName.optional(),
  tier: z.enum(MODEL_TIERS).default('fast'),
  /** The code in the editor, which may have unsaved edits. */
  code: z.string().max(MAX_AGENT_CODE_LENGTH, 'This song is too long for the agent'),
  baseVersionId: z.number().int().positive(),
});
export type AgentProposeRequest = z.input<typeof agentProposeRequestSchema>;

export const agentRepairRequestSchema = z.object({
  /** What went wrong when the proposal was tried in the player. */
  error: z.string().trim().min(1).max(2000),
});

export interface AgentProposalDto {
  id: number;
  songId: number;
  status: 'pending' | 'accepted' | 'rejected';
  instruction: string;
  summary: string;
  /** The song code before and after. */
  baseCode: string;
  code: string;
  brief: MusicBrief | null;
  repairs: number;
  model: string;
  costUsd: number;
}

export interface AgentUsageDto {
  enabled: boolean;
  /** Spent in the last 7 days, in USD. */
  spentUsd: number;
  limitUsd: number;
  groupSpentUsd: number;
  groupLimitUsd: number;
}

// ---------- admin ----------

export const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

export const agentSettingsSchema = z.object({
  modelFast: z.string().regex(MODEL_ID, 'Invalid model id').max(120),
  modelStrong: z.string().regex(MODEL_ID, 'Invalid model id').max(120),
  /** Used when the other models fail; empty for none. */
  modelFallback: z.union([z.literal(''), z.string().regex(MODEL_ID, 'Invalid model id').max(120)]),
  userWeeklyLimitUsd: z.number().min(0).max(1000),
  globalWeeklyLimitUsd: z.number().min(0).max(1000),
});
export type AgentSettings = z.infer<typeof agentSettingsSchema>;

export interface AgentCallDto {
  id: number;
  at: string;
  username: string | null;
  songId: number | null;
  purpose: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  status: string;
}

export interface AgentAdminDto {
  enabled: boolean;
  settings: AgentSettings;
  spending: { username: string; spentUsd: number; calls: number }[];
  totalUsd: number;
  recent: AgentCallDto[];
}
