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
}

export function assertWithinLimits(app: FastifyInstance, userId: number, settings: AgentSettings): void {
  if (!app.llm.enabled) throw new HttpError(503, 'The agent is not configured on this server');
  if (agentCalls.spentByUser(app.db, userId) >= settings.userWeeklyLimitUsd)
    throw new HttpError(429, 'You reached your weekly agent limit. It frees up as old calls pass 7 days.');
  if (agentCalls.spentTotal(app.db) >= settings.globalWeeklyLimitUsd)
    throw new HttpError(429, 'The group reached its weekly agent limit. Ask the admin or try again later.');
}

/** Models to try, in order. */
export function modelOrder(settings: AgentSettings, tier: ModelTier): string[] {
  const first = tier === 'strong' ? settings.modelStrong : settings.modelFast;
  return [...new Set([first, settings.modelFallback].filter(Boolean))];
}

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
    return result;
  } catch (e) {
    const costUsd = e instanceof LlmError ? e.costUsd : 0;
    agentCalls.log(app.db, { userId, songId, purpose, model, costUsd, status: 'error' });
    throw e;
  }
}

export interface CheckedAnswer {
  answer: AgentAnswer;
  code: string;
  model: string;
  costUsd: number;
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
  input: {
    messages: ChatMessage[];
    tier: ModelTier;
    onText?(textSoFar: string): void;
    signal?: AbortSignal;
  },
): Promise<{ content: string; model: string; costUsd: number }> {
  const settings = agentSettings.get(ctx.app.db, ctx.app.config);
  let costUsd = 0;
  let lastProblem = 'The model did not give a usable answer';
  for (const model of modelOrder(settings, input.tier)) {
    assertWithinLimits(ctx.app, ctx.userId, settings);
    try {
      const r = await callModel(ctx, model, input.messages, {
        maxTokens: MAX_TOKENS[input.tier],
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
  input: {
    messages: ChatMessage[];
    baseCode: string;
    tier: ModelTier;
    onText?(textSoFar: string): void;
    signal?: AbortSignal;
  },
): Promise<CheckedAnswer> {
  const settings = agentSettings.get(ctx.app.db, ctx.app.config);
  assertWithinLimits(ctx.app, ctx.userId, settings);
  let costUsd = 0;
  let lastProblem = 'The model did not give a usable answer';

  for (const model of modelOrder(settings, input.tier)) {
    const messages = [...input.messages];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      assertWithinLimits(ctx.app, ctx.userId, settings);
      let content: string;
      let usedModel: string;
      try {
        const r = await callModel(ctx, model, messages, {
          maxTokens: MAX_TOKENS[input.tier],
          json: true,
          ...(input.onText ? { onText: input.onText } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        costUsd += r.costUsd;
        content = r.content;
        usedModel = r.model;
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
        messages.push({ role: 'assistant', content: content.slice(0, 20_000) }, repairMessage(lastProblem));
      }
    }
  }
  throw new HttpError(502, `The agent could not finish: ${lastProblem.split('\n')[0]!.slice(0, 200)}`);
}
