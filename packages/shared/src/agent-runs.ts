// Logs of agent runs: what the admin sees, and the file format that scripts/eval-models.ts replays.
import { z } from 'zod';

/** Runs that nobody marked are deleted after this many days. */
export const AGENT_RUN_RETENTION_DAYS = 90;
export const MAX_AGENT_RUN_NOTE_LENGTH = 2000;
export const AGENT_RUNS_PAGE_SIZE = 100;
/** Shown wherever people send something to the agent. */
export const AGENT_PRIVACY_NOTE =
  'The admin can read the requests and code you send to the agent, and the versions of songs you use it on, even private ones.';

export const AGENT_RUN_STATUSES = ['running', 'ok', 'failed', 'cancelled'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

const decision = z.enum(['pending', 'accepted', 'rejected']).nullable();

const attemptSchema = z.object({
  number: z.number().int(),
  at: z.string(),
  model: z.string(),
  systemPromptHash: z.string().nullable(),
  /** Everything sent to the model except the system prompt, which is stored once under its hash. */
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })),
  /** The visible answer. A model's thinking is neither requested nor stored. */
  answer: z.string().nullable(),
  /** Why the app's checks turned the answer down. */
  rejection: z.string().nullable(),
  /** What went wrong with the call itself. */
  error: z.string().nullable(),
  finishReason: z.string().nullable(),
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  cachedTokens: z.number().nullable(),
  /** Includes the retries of a busy provider within this attempt. */
  costUsd: z.number(),
  durationMs: z.number(),
});
export type AgentRunAttemptDto = z.infer<typeof attemptSchema>;

const runSchema = z.object({
  id: z.number().int(),
  at: z.string(),
  finishedAt: z.string().nullable(),
  songId: z.number().int().nullable(),
  songTitle: z.string().nullable(),
  proposalId: z.number().int().nullable(),
  purpose: z.string(),
  tier: z.string(),
  request: z.string(),
  inputCode: z.string().nullable(),
  outputCode: z.string().nullable(),
  status: z.enum(AGENT_RUN_STATUSES),
  error: z.string().nullable(),
  /** The user's answer to the proposal, if the run led to one. */
  decision,
  flagged: z.boolean(),
  note: z.string(),
  attempts: z.array(attemptSchema),
});
export type AgentRunExport = z.infer<typeof runSchema>;

const versionSchema = z.object({
  id: z.number().int(),
  number: z.number().int(),
  parentVersionId: z.number().int().nullable(),
  /** 'user' is a change made by hand. */
  authorKind: z.enum(['user', 'agent']),
  message: z.string().nullable(),
  code: z.string(),
});
export type AgentHistoryVersion = z.infer<typeof versionSchema>;

const songSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  brief: z.record(z.string(), z.string()).nullable(),
});

const runEventSchema = z.object({
  kind: z.literal('run'),
  at: z.string(),
  run: runSchema,
  /** The code sent to the agent differs from the last saved version: edited by hand, or a proposal on trial. */
  editedSinceLastVersion: z.boolean(),
});
const versionEventSchema = z.object({ kind: z.literal('version'), at: z.string(), version: versionSchema });

/**
 * A downloaded file, in the order things happened. Parsing with this schema also drops every field it does not
 * name, which keeps user names out of the file.
 */
export const agentRunsExportSchema = z.object({
  format: z.literal('s-maker-agent-runs'),
  version: z.literal(1),
  exportedAt: z.string(),
  kind: z.enum(['marked', 'song']),
  /** Only for the history of one song. */
  song: songSchema.nullable(),
  systemPrompts: z.record(z.string(), z.string()),
  events: z.array(z.discriminatedUnion('kind', [runEventSchema, versionEventSchema])),
});
export type AgentRunsExport = z.infer<typeof agentRunsExportSchema>;

export const agentRunPatchSchema = z
  .object({
    flagged: z.boolean().optional(),
    note: z.string().trim().max(MAX_AGENT_RUN_NOTE_LENGTH).optional(),
  })
  .strict()
  .refine((p) => p.flagged !== undefined || p.note !== undefined, { message: 'Nothing to change' });

/** Who asked is shown only to the admin in the app, never written to a file. */
export type AgentRunDetailDto = AgentRunExport & { username: string | null };

export interface AgentRunSummaryDto {
  id: number;
  at: string;
  username: string | null;
  songId: number | null;
  songTitle: string | null;
  purpose: string;
  tier: string;
  request: string;
  status: AgentRunStatus;
  error: string | null;
  decision: 'pending' | 'accepted' | 'rejected' | null;
  flagged: boolean;
  note: string;
  attemptCount: number;
  rejectedCount: number;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface AgentRunListDto {
  runs: AgentRunSummaryDto[];
  total: number;
}

export type AgentHistoryEventDto =
  | { kind: 'run'; at: string; run: AgentRunDetailDto; editedSinceLastVersion: boolean }
  | { kind: 'version'; at: string; version: AgentHistoryVersion };

/** One song from the start, as it happened: requests, answers, saved versions and changes made by hand. */
export interface AgentSongHistoryDto {
  song: z.infer<typeof songSchema>;
  events: AgentHistoryEventDto[];
}

/** A logged request to send again to another model. */
export interface AgentReplayTask {
  runId: number;
  purpose: string;
  tier: string;
  request: string;
  /** The code the answer's changes apply to. */
  baseCode: string;
  /** What the first attempt sent, with the system prompt back in its place. */
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  original: {
    model: string;
    status: AgentRunStatus;
    decision: 'pending' | 'accepted' | 'rejected' | null;
    outputCode: string | null;
    costUsd: number;
  };
}

/** Reads a downloaded file. Throws if it is not one, or if a system prompt is missing from it. */
export function replayTasksFrom(file: unknown): AgentReplayTask[] {
  const parsed = agentRunsExportSchema.parse(file);
  return parsed.events.flatMap((event) => {
    if (event.kind !== 'run') return [];
    const { run } = event;
    const first = run.attempts[0];
    // Stopped before any model was asked, for example by a spending limit.
    if (!first) return [];
    const hash = first.systemPromptHash;
    const system = hash === null ? undefined : parsed.systemPrompts[hash];
    if (hash !== null && system === undefined)
      throw new Error(`Run ${run.id}: system prompt not in the file`);
    return [
      {
        runId: run.id,
        purpose: run.purpose,
        tier: run.tier,
        request: run.request,
        baseCode: run.inputCode ?? '',
        messages: [
          ...(system === undefined ? [] : [{ role: 'system' as const, content: system }]),
          ...first.messages,
        ],
        original: {
          model: first.model,
          status: run.status,
          decision: run.decision,
          outputCode: run.outputCode,
          costUsd: run.attempts.reduce((sum, a) => sum + a.costUsd, 0),
        },
      },
    ];
  });
}
