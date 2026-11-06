import type { AgentModelsDto, AgentProposalDto, AgentRunDetailDto, SongDto } from '@s-maker/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenRouterClient, LlmError, type ChatRequest, type LlmClient } from '../src/agent/openrouter';
import { call, createTestApp, createUser, setupAdmin, type Client } from './helpers';

const COMPARE = 'other/model';
const OTHER = 'z-ai/glm-5.3';
const ANSWER = JSON.stringify({
  summary: 'Changed the bass',
  changes: [{ type: 'track', name: 'bass', code: 'note("c2 g1").s("gm_synth_bass_1")' }],
});

let app: FastifyInstance;
let admin: Client;
let bob: Client;
let song: SongDto;
let requests: ChatRequest[];
let answers: (string | Error)[];

beforeEach(async () => {
  requests = [];
  answers = [];
  const llm: LlmClient = {
    enabled: true,
    async chat(req) {
      requests.push(req);
      const next = answers.shift() ?? ANSWER;
      if (next instanceof Error) throw next;
      return {
        content: next,
        model: req.model,
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0.01,
        reasoningTokens: null,
        cachedTokens: null,
        finishReason: 'stop',
      };
    },
    async listModels() {
      return ['deepseek/deepseek-v4.1-flash', OTHER, COMPARE];
    },
  };
  ({ app } = await createTestApp({}, llm));
  admin = await setupAdmin(app);
  bob = await createUser(app, admin, 'bob');
  song = (await call(app, admin, 'POST', '/api/songs', { title: 'S' })).json() as SongDto;
});
afterEach(async () => {
  await app.close();
});

const setList = (client: Client, models: string[]) =>
  call(app, client, 'PUT', '/api/admin/agent/models', { models });

const propose = (client: Client, target: SongDto, model: string) =>
  call(app, client, 'POST', `/api/songs/${target.id}/agent/proposals`, {
    instruction: 'Change the bass',
    code: target.currentVersion.code,
    baseVersionId: target.currentVersion.id,
    model,
  });

describe('choosing a model', () => {
  it('sends the request to the chosen model, with the larger token limit', async () => {
    await setList(admin, [COMPARE]);
    const res = await propose(admin, song, COMPARE);
    expect(res.statusCode).toBe(201);
    expect((res.json() as AgentProposalDto).model).toBe(COMPARE);
    expect(requests[0]!.model).toBe(COMPARE);
    expect(requests[0]!.maxTokens).toBe(32000);
  });

  it('marks the run as picked in the log', async () => {
    await setList(admin, [COMPARE]);
    await propose(admin, song, COMPARE);
    const { runs } = (await call(app, admin, 'GET', '/api/admin/agent/runs')).json() as {
      runs: { id: number }[];
    };
    const run = (
      await call(app, admin, 'GET', `/api/admin/agent/runs/${runs[0]!.id}`)
    ).json() as AgentRunDetailDto;
    expect(run.tier).toBe('picked');
    expect(run.attempts[0]!.model).toBe(COMPARE);
  });

  it('has no fallback: a failure is not hidden by another model answering', async () => {
    await setList(admin, [COMPARE]);
    answers.push(new LlmError('The model provider is busy (503)', true));
    const res = await propose(admin, song, COMPARE);
    expect(res.statusCode).toBe(502);
    expect(requests.map((r) => r.model)).toEqual([COMPARE]);
  });

  it('sends a repair to the same model', async () => {
    await setList(admin, [COMPARE]);
    const proposal = (await propose(admin, song, COMPARE)).json() as AgentProposalDto;
    const res = await call(
      app,
      admin,
      'POST',
      `/api/songs/${song.id}/agent/proposals/${proposal.id}/repair`,
      { error: 'sound not found' },
    );
    expect(res.statusCode).toBe(200);
    expect(requests.map((r) => r.model)).toEqual([COMPARE, COMPARE]);
  });

  it('works in the chat, in explanations and when composing', async () => {
    await setList(admin, [COMPARE]);
    await call(app, admin, 'POST', `/api/songs/${song.id}/agent/chat`, {
      message: 'Change the bass',
      code: song.currentVersion.code,
      baseVersionId: song.currentVersion.id,
      model: COMPARE,
    });
    answers.push('An explanation');
    await call(app, admin, 'POST', `/api/songs/${song.id}/explanations`, { model: COMPARE });
    answers.push(
      JSON.stringify({
        summary: 'Composed',
        changes: [{ type: 'add', name: 'bass', code: 'note("c2").s("gm_tuba")' }],
      }),
    );
    await call(app, admin, 'POST', '/api/agent/compose', { description: 'A song', model: COMPARE });
    expect(requests.map((r) => r.model)).toEqual([COMPARE, COMPARE, COMPARE]);
  });

  it('refuses a model that is not on the list', async () => {
    await setList(admin, [COMPARE]);
    const res = await propose(admin, song, OTHER);
    expect(res.statusCode).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('refuses a model id in the wrong form', async () => {
    const res = await propose(admin, song, 'not a model');
    expect(res.statusCode).toBe(400);
  });

  it('refuses a choice by anyone but the admin, on every kind of request', async () => {
    await setList(admin, [COMPARE]);
    const own = (await call(app, bob, 'POST', '/api/songs', { title: 'B' })).json() as SongDto;
    const replies = await Promise.all([
      propose(bob, own, COMPARE),
      call(app, bob, 'POST', `/api/songs/${own.id}/agent/chat`, {
        message: 'Hi',
        code: own.currentVersion.code,
        baseVersionId: own.currentVersion.id,
        model: COMPARE,
      }),
      call(app, bob, 'POST', `/api/songs/${own.id}/explanations`, { model: COMPARE }),
      call(app, bob, 'POST', '/api/agent/compose', { description: 'A song', model: COMPARE }),
    ]);
    expect(replies.map((r) => r.statusCode)).toEqual([403, 403, 403, 403]);
    expect(requests).toHaveLength(0);
  });
});

describe('the list of models', () => {
  it('starts empty and is saved', async () => {
    const empty = (await call(app, admin, 'GET', '/api/agent/models')).json() as AgentModelsDto;
    expect(empty).toEqual({ canPick: true, models: [] });
    expect((await setList(admin, [COMPARE, COMPARE])).statusCode).toBe(200);
    const saved = (await call(app, admin, 'GET', '/api/agent/models')).json() as AgentModelsDto;
    expect(saved.models.map((m) => m.id)).toEqual([COMPARE]);
  });

  it('refuses a model OpenRouter does not have, but lets one that disappeared be removed', async () => {
    expect((await setList(admin, ['made/up-model'])).statusCode).toBe(400);
    await setList(admin, [COMPARE]);
    expect((await setList(admin, [])).statusCode).toBe(200);
  });

  it('is open only to the admin', async () => {
    const seen = (await call(app, bob, 'GET', '/api/agent/models')).json() as AgentModelsDto;
    await setList(admin, [COMPARE]);
    const after = (await call(app, bob, 'GET', '/api/agent/models')).json() as AgentModelsDto;
    expect(seen).toEqual({ canPick: false, models: [] });
    expect(after).toEqual({ canPick: false, models: [] });
    expect((await setList(bob, [COMPARE])).statusCode).toBe(403);
    expect((await call(app, bob, 'GET', '/api/admin/agent/catalog')).statusCode).toBe(403);
    expect((await call(app, null, 'GET', '/api/agent/models')).statusCode).toBe(401);
    expect((await call(app, null, 'GET', '/api/admin/agent/catalog')).statusCode).toBe(401);
  });
});

describe('prices from OpenRouter', () => {
  it('turns prices per token into prices per million, and copes with missing ones', async () => {
    const client = createOpenRouterClient({
      apiKey: 'k',
      baseUrl: 'https://x',
      publicUrl: 'https://y',
      fetch: (async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'a/b', pricing: { prompt: '0.000004', completion: '0.00002' } },
              { id: 'c/d' },
              { id: 'e/f', pricing: { prompt: 'n/a', completion: '-1' } },
            ],
          }),
        )) as typeof fetch,
    });
    expect(await client.listCatalog!()).toEqual([
      { id: 'a/b', promptUsdPerM: 4, completionUsdPerM: 20 },
      { id: 'c/d', promptUsdPerM: null, completionUsdPerM: null },
      { id: 'e/f', promptUsdPerM: null, completionUsdPerM: null },
    ]);
  });
});
