import type { AgentAdminDto, AgentProposalDto, AgentUsageDto, SongDto, VersionDto } from '@s-maker/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createOpenRouterClient,
  LlmError,
  type ChatRequest,
  type ChatResult,
  type LlmClient,
} from '../src/agent/openrouter';
import { systemPrompt } from '../src/agent/prompt';
import { call, createTestApp, createUser, setupAdmin, type Client } from './helpers';

/** A model that answers from a queue and records what it was asked. */
function fakeLlm(enabled = true) {
  const queue: (string | Error | Partial<ChatResult>)[] = [];
  const requests: ChatRequest[] = [];
  const client: LlmClient = {
    enabled,
    async chat(req) {
      requests.push(req);
      const next = queue.shift();
      if (next === undefined) throw new Error('no fake answer queued');
      if (next instanceof Error) throw next;
      const r = typeof next === 'string' ? { content: next } : next;
      return {
        content: '{}',
        model: req.model,
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.01,
        ...r,
      };
    },
    async listModels() {
      return ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3', 'other/model'];
    },
  };
  return { client, queue, requests };
}

const answer = (changes: unknown[], extra: object = {}) =>
  JSON.stringify({ summary: 'Changed the bass', changes, ...extra });
const newBass = { type: 'track', name: 'bass', code: 'note("c2 g1").s("gm_synth_bass_1")' };

let app: FastifyInstance;
let alice: Client;
let bob: Client;
let llm: ReturnType<typeof fakeLlm>;
let song: SongDto;

beforeEach(async () => {
  llm = fakeLlm();
  ({ app } = await createTestApp({}, llm.client));
  alice = await setupAdmin(app);
  bob = await createUser(app, alice, 'bob');
  song = (await call(app, alice, 'POST', '/api/songs', { title: 'S' })).json() as SongDto;
});
afterEach(async () => {
  await app.close();
});

const propose = (client: Client, extra: object = {}) =>
  call(app, client, 'POST', `/api/songs/${song.id}/agent/proposals`, {
    instruction: 'Make the bass synthetic',
    code: song.currentVersion.code,
    baseVersionId: song.currentVersion.id,
    ...extra,
  });

describe('agent proposals', () => {
  it('returns a checked proposal without saving anything', async () => {
    llm.queue.push(answer([newBass]));
    const res = await propose(alice);
    expect(res.statusCode).toBe(201);
    const p = res.json() as AgentProposalDto;
    expect(p.summary).toBe('Changed the bass');
    expect(p.code).toContain('bass: note("c2 g1").s("gm_synth_bass_1")');
    expect(p.code).toContain('drums:'); // the rest is untouched
    expect(p.baseCode).toBe(song.currentVersion.code);
    expect(p.costUsd).toBeCloseTo(0.01);
    const fresh = (await call(app, alice, 'GET', `/api/songs/${song.id}`)).json() as SongDto;
    expect(fresh.versionCount).toBe(1);
  });

  it('sends the rules first, the song as data and the request last', async () => {
    llm.queue.push(answer([newBass]));
    await propose(alice, { track: 'bass', instruction: 'IGNORE' });
    const [system, user] = llm.requests[0]!.messages;
    expect(system!.role).toBe('system');
    expect(system!.content).toContain('# Strudel reference');
    expect(system!.content).toContain('Accentuation');
    expect(user!.content).toContain('<song>');
    expect(user!.content.indexOf('<song>')).toBeLessThan(user!.content.indexOf('# REQUEST'));
    expect(user!.content).toContain('Change only the track "bass"');
    expect(llm.requests[0]!.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(llm.requests[0]!.json).toBe(true);
  });

  it('uses the strong model when asked', async () => {
    llm.queue.push(answer([newBass]));
    await propose(alice, { tier: 'strong' });
    expect(llm.requests[0]!.model).toBe('deepseek/deepseek-v4-pro-0813');
  });

  it('accepts JSON in a code fence and a repeated label', async () => {
    llm.queue.push(
      '```json\n' +
        answer([{ type: 'track', name: 'bass', code: 'bass: note("c2").s("gm_tuba")' }]) +
        '\n```',
    );
    const p = (await propose(alice)).json() as AgentProposalDto;
    expect(p.code).toContain('bass: note("c2").s("gm_tuba")');
    expect(p.code).not.toContain('bass: bass:');
  });

  it.each([
    ['not JSON', 'Sure! Here is your bass.'],
    ['a wrong format', JSON.stringify({ changes: 'bass' })],
    ['an unknown track', answer([{ type: 'track', name: 'nope', code: 'note("c2")' }])],
    ['a syntax error', answer([{ type: 'track', name: 'bass', code: 'note("c2"' }])],
    ['forbidden code', answer([{ type: 'track', name: 'bass', code: 'fetch("https://evil.example")' }])],
    [
      'forbidden code through the header',
      answer([{ type: 'header', code: 'const x = globalThis.document\nsetcpm(1)' }]),
    ],
  ])('sends %s back to the model, then succeeds', async (_name, bad) => {
    llm.queue.push(bad, answer([newBass]));
    const res = await propose(alice);
    expect(res.statusCode).toBe(201);
    expect(llm.requests).toHaveLength(2);
    const second = llm.requests[1]!.messages;
    expect(second[second.length - 1]!.content).toContain('cannot be used');
    expect((res.json() as AgentProposalDto).costUsd).toBeCloseTo(0.02);
  });

  it('gives up after 3 bad answers from each model and never shows forbidden code', async () => {
    const evil = answer([{ type: 'track', name: 'bass', code: 'window.location="https://evil.example"' }]);
    llm.queue.push(evil, evil, evil, evil, evil, evil);
    const res = await propose(alice);
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('evil.example');
    expect(llm.requests.map((r) => r.model)).toEqual([
      ...Array<string>(3).fill('deepseek/deepseek-v4.1-flash'),
      ...Array<string>(3).fill('z-ai/glm-5.3'),
    ]);
  });

  it('counts what failed calls cost, in the log and against the limit', async () => {
    llm.queue.push(new LlmError('The model returned an empty answer', true, 0.02), answer([newBass]));
    const p = (await propose(alice)).json() as AgentProposalDto;
    expect(p.costUsd).toBeCloseTo(0.03);
    const admin = (await call(app, alice, 'GET', '/api/admin/agent')).json() as AgentAdminDto;
    expect(admin.recent.find((c) => c.status === 'error')?.costUsd).toBeCloseTo(0.02);
    const usage = (await call(app, alice, 'GET', '/api/agent/usage')).json() as AgentUsageDto;
    expect(usage.spentUsd).toBeCloseTo(0.03);
  });

  it('moves on to the fallback model when the provider fails', async () => {
    const put = await call(app, alice, 'PUT', '/api/admin/agent/settings', {
      modelFast: 'deepseek/deepseek-v4.1-flash',
      modelStrong: 'z-ai/glm-5.3',
      modelFallback: 'other/model',
      userWeeklyLimitUsd: 3,
      globalWeeklyLimitUsd: 10,
    });
    expect(put.statusCode).toBe(200);
    llm.queue.push(new LlmError('The model provider is busy (503)', true), answer([newBass]));
    const p = (await propose(alice)).json() as AgentProposalDto;
    expect(p.model).toBe('other/model');
  });

  it('stops at once when the key is rejected', async () => {
    llm.queue.push(new LlmError('The API key was rejected by OpenRouter', false));
    const res = await propose(alice);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'The API key was rejected by OpenRouter' });
    expect(llm.requests).toHaveLength(1);
  });

  it('adds, removes and rewrites the header', async () => {
    llm.queue.push(
      answer([
        { type: 'remove', name: 'keys' },
        { type: 'add', name: 'Lead 1', code: 'note("c4").s("gm_flute")' },
        { type: 'header', code: 'const a = note("c3")\nsetcpm(90/4)' },
      ]),
    );
    const p = (await propose(alice)).json() as AgentProposalDto;
    expect(p.code.startsWith('const a = note("c3")\nsetcpm(90/4)\n\ndrums:')).toBe(true);
    expect(p.code).toContain('lead_1: note("c4").s("gm_flute")');
    expect(p.code).not.toContain('keys:');
  });

  it('checks the input', async () => {
    expect((await propose(alice, { instruction: '  ' })).statusCode).toBe(400);
    expect((await propose(alice, { tier: 'huge' })).statusCode).toBe(400);
    expect((await propose(alice, { code: 'x'.repeat(60_001) })).statusCode).toBe(400);
    expect(llm.requests).toHaveLength(0);
  });
});

describe('access', () => {
  it('only the owner can use the agent on a song', async () => {
    expect((await propose(bob)).statusCode).toBe(403);
    await call(app, alice, 'PATCH', `/api/songs/${song.id}`, { visibility: 'private' });
    expect((await propose(bob)).statusCode).toBe(404);
    expect((await call(app, null, 'POST', `/api/songs/${song.id}/agent/proposals`, {})).statusCode).toBe(401);
    expect(llm.requests).toHaveLength(0);
  });

  it("proposals of a song can't be used by others", async () => {
    llm.queue.push(answer([newBass]));
    const p = (await propose(alice)).json() as AgentProposalDto;
    for (const action of ['accept', 'reject', 'repair']) {
      const res = await call(app, bob, 'POST', `/api/songs/${song.id}/agent/proposals/${p.id}/${action}`, {
        error: 'x',
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('the admin endpoints are for admins', async () => {
    expect((await call(app, bob, 'GET', '/api/admin/agent')).statusCode).toBe(403);
    expect((await call(app, bob, 'PUT', '/api/admin/agent/settings', {})).statusCode).toBe(403);
    expect((await call(app, null, 'GET', '/api/agent/usage')).statusCode).toBe(401);
  });
});

describe('accepting and rejecting', () => {
  const proposalOf = async () => {
    llm.queue.push(answer([newBass], { brief: { timbre: 'Synth bass' } }));
    return (await propose(alice)).json() as AgentProposalDto;
  };
  const url = (p: AgentProposalDto, action: string) =>
    `/api/songs/${song.id}/agent/proposals/${p.id}/${action}`;

  it('accepting saves a version by the agent and updates the brief', async () => {
    const p = await proposalOf();
    const res = await call(app, alice, 'POST', url(p, 'accept'));
    expect(res.statusCode).toBe(201);
    const { version, song: fresh } = res.json() as { version: VersionDto; song: SongDto };
    expect(version).toMatchObject({
      number: 2,
      authorKind: 'agent',
      message: 'Changed the bass',
      code: p.code,
    });
    expect(fresh.brief).toMatchObject({ timbre: 'Synth bass' });
    // Only once.
    expect((await call(app, alice, 'POST', url(p, 'accept'))).statusCode).toBe(409);
  });

  it('accepting fails when the song moved on', async () => {
    const p = await proposalOf();
    await call(app, alice, 'POST', `/api/songs/${song.id}/versions`, {
      code: 'note("c3")',
      baseVersionId: song.currentVersion.id,
    });
    expect((await call(app, alice, 'POST', url(p, 'accept'))).statusCode).toBe(409);
  });

  it('rejecting closes it', async () => {
    const p = await proposalOf();
    expect((await call(app, alice, 'POST', url(p, 'reject'))).statusCode).toBe(200);
    expect((await call(app, alice, 'POST', url(p, 'accept'))).statusCode).toBe(409);
  });

  it('repair gives the player error to the model, at most twice', async () => {
    const p = await proposalOf();
    const fix = (s: string) =>
      answer([{ type: 'track', name: 'bass', code: `note("c2").s("${s}")` }], { summary: 'Fixed' });
    llm.queue.push(fix('gm_tuba'), fix('gm_piano'));
    const r1 = await call(app, alice, 'POST', url(p, 'repair'), { error: 'unknown sound "gm_synth_bass_1"' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ repairs: 1, summary: 'Fixed' });
    const last = llm.requests[llm.requests.length - 1]!.messages.at(-1)!;
    expect(last.content).toContain('unknown sound');
    const r2 = (
      await call(app, alice, 'POST', url(p, 'repair'), { error: 'again' })
    ).json() as AgentProposalDto;
    expect(r2.code).toContain('gm_piano');
    expect(r2.costUsd).toBeCloseTo(0.03);
    expect((await call(app, alice, 'POST', url(p, 'repair'), { error: 'again' })).statusCode).toBe(422);
  });
});

describe('costs', () => {
  it('counts what each user spends', async () => {
    llm.queue.push({ content: answer([newBass]), costUsd: 0.25 });
    await propose(alice);
    const usage = (await call(app, alice, 'GET', '/api/agent/usage')).json() as AgentUsageDto;
    expect(usage).toMatchObject({ enabled: true, spentUsd: 0.25, limitUsd: 3, groupSpentUsd: 0.25 });
    const other = (await call(app, bob, 'GET', '/api/agent/usage')).json() as AgentUsageDto;
    expect(other.spentUsd).toBe(0);
    const admin = (await call(app, alice, 'GET', '/api/admin/agent')).json() as AgentAdminDto;
    expect(admin.spending).toEqual([{ username: 'admin', spentUsd: 0.25, calls: 1 }]);
    expect(admin.recent[0]).toMatchObject({ purpose: 'song', costUsd: 0.25, status: 'ok' });
  });

  it('refuses when the user limit is reached', async () => {
    llm.queue.push({ content: answer([newBass]), costUsd: 3 });
    expect((await propose(alice)).statusCode).toBe(201);
    const res = await propose(alice);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('weekly agent limit') });
    expect(llm.requests).toHaveLength(1);
  });

  it('refuses when the group limit is reached', async () => {
    llm.queue.push({ content: answer([newBass]), costUsd: 2.9 });
    const put = await call(app, alice, 'PUT', '/api/admin/agent/settings', {
      modelFast: 'deepseek/deepseek-v4.1-flash',
      modelStrong: 'z-ai/glm-5.3',
      modelFallback: '',
      userWeeklyLimitUsd: 3,
      globalWeeklyLimitUsd: 2.5,
    });
    expect(put.statusCode).toBe(200);
    await propose(alice);
    const bobSong = (await call(app, bob, 'POST', '/api/songs', { title: 'B' })).json() as SongDto;
    const res = await call(app, bob, 'POST', `/api/songs/${bobSong.id}/agent/proposals`, {
      instruction: 'x',
      code: 'note("c3")',
      baseVersionId: bobSong.currentVersion.id,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('group') });
  });

  it('stops retrying when a retry would pass the limit', async () => {
    llm.queue.push({ content: 'not json', costUsd: 3 }, answer([newBass]));
    expect((await propose(alice)).statusCode).toBe(429);
    expect(llm.requests).toHaveLength(1);
  });

  it('runs one request per user at a time', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const original = llm.client.chat.bind(llm.client);
    llm.client.chat = async (req) => {
      await gate;
      return original(req);
    };
    llm.queue.push(answer([newBass]));
    const first = propose(alice);
    await new Promise((r) => setTimeout(r, 20));
    expect((await propose(alice)).statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(201);
  });

  it('is off without a key', async () => {
    await app.close();
    llm = fakeLlm(false);
    ({ app } = await createTestApp({}, llm.client));
    alice = await setupAdmin(app);
    song = (await call(app, alice, 'POST', '/api/songs', { title: 'S' })).json() as SongDto;
    expect((await propose(alice)).statusCode).toBe(503);
    const usage = (await call(app, alice, 'GET', '/api/agent/usage')).json() as AgentUsageDto;
    expect(usage.enabled).toBe(false);
  });
});

describe('admin settings', () => {
  const settings = {
    modelFast: 'deepseek/deepseek-v4.1-flash',
    modelStrong: 'z-ai/glm-5.3',
    modelFallback: '',
    userWeeklyLimitUsd: 1,
    globalWeeklyLimitUsd: 2,
  };
  it('saves valid settings', async () => {
    const res = await call(app, alice, 'PUT', '/api/admin/agent/settings', settings);
    expect(res.statusCode).toBe(200);
    const admin = (await call(app, alice, 'GET', '/api/admin/agent')).json() as AgentAdminDto;
    expect(admin.settings).toEqual(settings);
  });
  it('rejects models that do not exist and bad values', async () => {
    for (const bad of [
      { ...settings, modelFast: 'made/up-model' },
      { ...settings, modelStrong: 'not a model id' },
      { ...settings, userWeeklyLimitUsd: -1 },
    ]) {
      expect((await call(app, alice, 'PUT', '/api/admin/agent/settings', bad)).statusCode).toBe(400);
    }
  });
});

describe('OpenRouter client', () => {
  const ok = (body: object, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const good = {
    model: 'm/x',
    choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
  };
  const client = (f: typeof fetch) =>
    createOpenRouterClient({
      apiKey: 'test-key',
      baseUrl: 'https://llm.test/v1',
      publicUrl: 'https://app.test',
      fetch: f,
      retryDelayMs: 1,
    });
  const req: ChatRequest = { model: 'm/x', messages: [{ role: 'user', content: 'q' }], maxTokens: 10 };

  it('sends the request and reads the cost', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const r = await client((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return ok(good);
    }) as typeof fetch).chat({ ...req, json: true });
    expect(r).toEqual({ content: 'hi', model: 'm/x', promptTokens: 10, completionTokens: 5, costUsd: 0.001 });
    const { url, init } = seen!;
    expect(url).toBe('https://llm.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ usage: { include: true }, response_format: { type: 'json_object' } });
  });

  it('retries busy and failing providers, then gives a retryable error', async () => {
    let n = 0;
    const r = await client((async () => (++n === 1 ? ok({}, 503) : ok(good))) as typeof fetch).chat(req);
    expect(r.content).toBe('hi');
    expect(n).toBe(2);
    n = 0;
    await expect(
      client((async () => {
        n++;
        return ok({ error: { message: 'boom' } });
      }) as typeof fetch).chat(req),
    ).rejects.toMatchObject({ retryable: true });
    expect(n).toBe(3);
  });

  it('does not retry a rejected key and never puts the key in errors', async () => {
    let n = 0;
    const e = await client((async () => {
      n++;
      return ok({}, 401);
    }) as typeof fetch)
      .chat(req)
      .catch((x: Error) => x);
    expect(n).toBe(1);
    expect((e as LlmError).retryable).toBe(false);
    expect((e as LlmError).message).not.toContain('test-key');
  });

  it('counts a high price when the cost is missing', async () => {
    const r = await client((async () =>
      ok({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 1000 },
      })) as typeof fetch).chat(req);
    expect(r.costUsd).toBeCloseTo(0.012);
  });

  it('counts the cost of answers that came back empty', async () => {
    // A model that spends its whole token limit on thinking is paid for and gives nothing.
    const empty = { choices: [{ message: { content: '' } }], usage: { cost: 0.005 } };
    let n = 0;
    const r = await client((async () => (++n === 1 ? ok(empty) : ok(good))) as typeof fetch).chat(req);
    expect(r.content).toBe('hi');
    expect(r.costUsd).toBeCloseTo(0.006);

    const e = await client((async () => ok(empty)) as typeof fetch)
      .chat(req)
      .catch((x: Error) => x);
    expect(e).toBeInstanceOf(LlmError);
    expect((e as LlmError).costUsd).toBeCloseTo(0.015);
  });

  it('refuses without a key', async () => {
    const c = createOpenRouterClient({ apiKey: undefined, baseUrl: 'https://x', publicUrl: 'https://y' });
    expect(c.enabled).toBe(false);
    await expect(c.chat(req)).rejects.toThrow(/not configured/);
  });
});

describe('knowledge base', () => {
  it('loads', () => {
    expect(systemPrompt()).toContain('Answer format');
  });
});
