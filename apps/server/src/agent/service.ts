// The agent loop: ask a model, check the answer, feed problems back, keep track of cost.
import {
  agentAnswerSchema,
  applyAgentChanges,
  extractJson,
  parseTracks,
  validateStrudelCode,
  type AgentAnswer,
  type AgentSettings,
  type ModelTier,
} from '@s-maker/shared';
import type { FastifyInstance } from 'fastify';
import { HttpError } from '../http-error';
import { LlmError, type ChatMessage } from './openrouter';
import { repairMessage } from './prompt';
import { agentRuns, quietly, type AttemptLog } from './runs';
import { agentCalls, agentSettings } from './store';

/** Attempts for one request when an answer does not pass the checks. */
const MAX_ATTEMPTS = 3;

/** Thinking counts towards this limit: at 6000 models often ran out before they began the answer. */
export const MAX_TOKENS: Record<ModelTier, number> = { fast: 16000, strong: 32000 };

export interface AgentContext {
  app: FastifyInstance;
  userId: number;
  songId: number | null;
  purpose: string;
  /** The log entry this call belongs to. Null if it could not be started. */
  runId?: number | null;
}

/** What goes into the log besides the model calls. */
export interface RunInfo {
  /** What the person asked for, in their own words. */
  request: string;
  /** Set when this run works on a proposal that already exists. */
  proposalId?: number;
  /** A model chosen by name, already checked by the route. */
  model?: string | undefined;
}

function startRun(
  ctx: AgentContext,
  input: RunInfo & { tier: ModelTier; inputCode: string | null },
): number | null {
  return quietly(ctx.app, () =>
    agentRuns.start(ctx.app.db, {
      userId: ctx.userId,
      songId: ctx.songId,
      proposalId: input.proposalId ?? null,
      purpose: ctx.purpose,
      tier: input.model ? 'picked' : input.tier,
      request: input.request,
      inputCode: input.inputCode,
    }),
  );
}

function finishRun(
  ctx: AgentContext,
  runId: number | null,
  outcome: { outputCode?: string } | { failure: unknown; signal?: AbortSignal | undefined },
): void {
  if (runId === null) return;
  quietly(ctx.app, () =>
    agentRuns.finish(
      ctx.app.db,
      runId,
      'failure' in outcome
        ? {
            status: outcome.signal?.aborted ? 'cancelled' : 'failed',
            error: outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure),
          }
        : { status: 'ok', outputCode: outcome.outputCode ?? null },
    ),
  );
}

/** Ties a finished run to the song or proposal that came out of it. */
export function linkRun(
  app: FastifyInstance,
  runId: number | null,
  link: { songId?: number; proposalId?: number },
): void {
  if (runId !== null) quietly(app, () => agentRuns.link(app.db, runId, link));
}

function logAttempt(ctx: AgentContext, attempt: AttemptLog): number | null {
  const { runId } = ctx;
  if (runId === undefined || runId === null) return null;
  return quietly(ctx.app, () => agentRuns.addAttempt(ctx.app.db, runId, attempt));
}

export function assertWithinLimits(app: FastifyInstance, userId: number, settings: AgentSettings): void {
  if (!app.llm.enabled) throw new HttpError(503, 'The agent is not configured on this server');
  if (agentCalls.spentByUser(app.db, userId) >= settings.userWeeklyLimitUsd)
    throw new HttpError(429, 'You reached your weekly agent limit. It frees up as old calls pass 7 days.');
  if (agentCalls.spentTotal(app.db) >= settings.globalWeeklyLimitUsd)
    throw new HttpError(429, 'The group reached its weekly agent limit. Ask the admin or try again later.');
}

/** Models to try, in order. A chosen model has no fallback: its result must really come from it. */
export function modelOrder(settings: AgentSettings, tier: ModelTier, chosen?: string): string[] {
  if (chosen) return [chosen];
  const first = tier === 'strong' ? settings.modelStrong : settings.modelFast;
  return [...new Set([first, settings.modelFallback].filter(Boolean))];
}

/** A chosen model gets the larger limit, so that models are compared under the same conditions. */
const maxTokensFor = (tier: ModelTier, chosen?: string): number =>
  chosen ? MAX_TOKENS.strong : MAX_TOKENS[tier];

/** One call to a model: logged with its cost whatever happens next. */
export async function callModel(
  ctx: AgentContext,
  model: string,
  messages: ChatMessage[],
  opts: {
    maxTokens: number;
    json?: boolean;
    temperature?: number;
    onText?(textSoFar: string): void;
    signal?: AbortSignal;
  },
) {
  const { app, userId, songId, purpose } = ctx;
  const started = Date.now();
  try {
    const result = await app.llm.chat({ model, messages, ...opts });
    agentCalls.log(app.db, {
      userId,
      songId,
      purpose,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsd: result.costUsd,
      status: 'ok',
    });
    const attemptId = logAttempt(ctx, {
      model: result.model,
      messages,
      answer: result.content,
      finishReason: result.finishReason,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      reasoningTokens: result.reasoningTokens,
      cachedTokens: result.cachedTokens,
      costUsd: result.costUsd,
      durationMs: Date.now() - started,
    });
    return { ...result, attemptId };
  } catch (e) {
    const costUsd = e instanceof LlmError ? e.costUsd : 0;
    agentCalls.log(app.db, { userId, songId, purpose, model, costUsd, status: 'error' });
    const message = e instanceof Error ? e.message : String(e);
    const info = e instanceof LlmError ? e.info : null;
    const providerMessage = e instanceof LlmError ? e.providerMessage : null;
    logAttempt(ctx, {
      model,
      messages,
      error: providerMessage ? `${message}: ${providerMessage}` : message,
      ...(info ?? {}),
      costUsd,
      durationMs: Date.now() - started,
    });
    throw e;
  }
}

export interface CheckedAnswer {
  answer: AgentAnswer;
  code: string;
  model: string;
  costUsd: number;
  /** The log entry of this run. Null if the log could not be written. */
  runId: number | null;
}

/** Everything an answer must pass before the user sees it. Returns the new code or throws with the reason. */
export function checkAnswer(raw: string, baseCode: string): { answer: AgentAnswer; code: string } {
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch {
    throw new Error('The answer is not valid JSON.');
  }
  const parsed = agentAnswerSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Wrong answer format at ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? ''}`);
  }
  const answer = parsed.data;
  // A chat reply changes nothing, so there is nothing to check.
  if (!answer.changes.length) return { answer, code: baseCode };
  const code = applyAgentChanges(baseCode, answer.changes);
  const tracks = parseTracks(code);
  if (!tracks.ok) throw new Error(`The new code has a syntax error: ${tracks.error}`);
  const validation = validateStrudelCode(code, 'strict');
  if (!validation.ok) {
    const problems = validation.issues
      .filter((i) => i.severity === 'error')
      .slice(0, 5)
      .map((i) => `line ${i.line}: ${i.message}`)
      .join('\n');
    throw new Error(`The new code is not allowed:\n${problems}`);
  }
  return { answer, code };
}

/** For an answer that is plain text: the first model that gives one, with the next as a fallback. */
export async function runText(
  ctx: AgentContext,
  input: RunInfo & {
    messages: ChatMessage[];
    tier: ModelTier;
    /** The code being talked about. */
    inputCode: string;
    onText?(textSoFar: string): void;
    signal?: AbortSignal;
  },
): Promise<{ content: string; model: string; costUsd: number }> {
  const runId = startRun(ctx, input);
  try {
    const result = await textLoop({ ...ctx, runId }, input);
    finishRun(ctx, runId, {});
    return result;
  } catch (e) {
    finishRun(ctx, runId, { failure: e, signal: input.signal });
    throw e;
  }
}

async function textLoop(
  ctx: AgentContext,
  input: {
    messages: ChatMessage[];
    tier: ModelTier;
    model?: string | undefined;
    onText?(textSoFar: string): void;
    signal?: AbortSignal;
  },
): Promise<{ content: string; model: string; costUsd: number }> {
  const settings = agentSettings.get(ctx.app.db, ctx.app.config);
  let costUsd = 0;
  let lastProblem = 'The model did not give a usable answer';
  for (const model of modelOrder(settings, input.tier, input.model)) {
    assertWithinLimits(ctx.app, ctx.userId, settings);
    try {
      const r = await callModel(ctx, model, input.messages, {
        maxTokens: maxTokensFor(input.tier, input.model),
        ...(input.onText ? { onText: input.onText } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { content: r.content, model: r.model, costUsd: costUsd + r.costUsd };
    } catch (e) {
      if (e instanceof LlmError) costUsd += e.costUsd;
      if (e instanceof LlmError && !e.retryable) throw new HttpError(502, e.message);
      lastProblem = e instanceof Error ? e.message : lastProblem;
    }
  }
  throw new HttpError(502, `The agent could not finish: ${lastProblem.slice(0, 200)}`);
}

/**
 * Runs the model until an answer passes the checks. A failed answer goes back to the model with the reason.
 * If a model keeps failing or its provider is down, the next model in the order takes over.
 */
export async function runAgent(
  ctx: AgentContext,
  input: RunInfo & {
    messages: ChatMessage[];
    baseCode: string;
    tier: ModelTier;
    onText?(textSoFar: string): void;
    signal?: AbortSignal;
  },
): Promise<CheckedAnswer> {
  const runId = startRun(ctx, { ...input, inputCode: input.baseCode });
  try {
    const result = await agentLoop({ ...ctx, runId }, input);
    finishRun(ctx, runId, { outputCode: result.code });
    return { ...result, runId };
  } catch (e) {
    finishRun(ctx, runId, { failure: e, signal: input.signal });
    throw e;
  }
}

async function agentLoop(
  ctx: AgentContext,
  input: {
    messages: ChatMessage[];
    baseCode: string;
    tier: ModelTier;
    model?: string | undefined;
    onText?(textSoFar: string): void;
    signal?: AbortSignal;
  },
): Promise<Omit<CheckedAnswer, 'runId'>> {
  const settings = agentSettings.get(ctx.app.db, ctx.app.config);
  assertWithinLimits(ctx.app, ctx.userId, settings);
  let costUsd = 0;
  let lastProblem = 'The model did not give a usable answer';

  for (const model of modelOrder(settings, input.tier, input.model)) {
    const messages = [...input.messages];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      assertWithinLimits(ctx.app, ctx.userId, settings);
      let content: string;
      let usedModel: string;
      let attemptId: number | null;
      try {
        const r = await callModel(ctx, model, messages, {
          maxTokens: maxTokensFor(input.tier, input.model),
          json: true,
          ...(input.onText ? { onText: input.onText } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        costUsd += r.costUsd;
        content = r.content;
        usedModel = r.model;
        attemptId = r.attemptId;
      } catch (e) {
        if (e instanceof LlmError) costUsd += e.costUsd;
        if (e instanceof LlmError && !e.retryable) throw new HttpError(502, e.message);
        lastProblem = e instanceof Error ? e.message : lastProblem;
        break; // provider trouble: next model
      }
      try {
        const { answer, code } = checkAnswer(content, input.baseCode);
        return { answer, code, model: usedModel, costUsd };
      } catch (e) {
        lastProblem = e instanceof Error ? e.message : lastProblem;
        if (attemptId !== null) {
          const id = attemptId;
          const reason = lastProblem;
          quietly(ctx.app, () => agentRuns.rejectAttempt(ctx.app.db, id, reason));
        }
        messages.push({ role: 'assistant', content: content.slice(0, 20_000) }, repairMessage(lastProblem));
      }
    }
  }
  throw new HttpError(502, `The agent could not finish: ${lastProblem.split('\n')[0]!.slice(0, 200)}`);
}
