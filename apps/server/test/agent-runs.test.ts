import {
  agentRunsExportSchema,
  replayTasksFrom,
  type AgentProposalDto,
  type AgentRunDetailDto,
  type AgentRunListDto,
  type AgentRunsExport,
  type AgentSongHistoryDto,
  type SongDto,
} from '@s-maker/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createOpenRouterClient,
  LlmError,
  type ChatRequest,
  type ChatResult,
  type LlmClient,
} from '../src/agent/openrouter';
import { agentRuns } from '../src/agent/runs';
import type { Db } from '../src/db';
import { call, createTestApp, createUser, setupAdmin, type Client } from './helpers';

function fakeLlm() {
  const queue: (string | Error | Partial<ChatResult>)[] = [];
  const client: LlmClient = {
    enabled: true,
    async chat(req: ChatRequest) {
      const next = queue.shift();
      if (next === undefined) throw new Error('no fake answer queued');
      if (next instanceof Error) throw next;
      return {
        content: '{}',
        model: req.model,
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 30,
        cachedTokens: 80,
        finishReason: 'stop',
        costUsd: 0.01,
        ...(typeof next === 'string' ? { content: next } : next),
      };
    },
    async listModels() {
      return [];
    },
  };
  return { client, queue };
}

const newBass = { type: 'track', name: 'bass', code: 'note("c2 g1").s("gm_synth_bass_1")' };
const answer = (changes: unknown[] = [newBass]) => JSON.stringify({ summary: 'Changed the bass', changes });
const tick = () => new Promise((r) => setTimeout(r, 2));

let app: FastifyInstance;
let db: Db;
let admin: Client;
let bob: Client;
let llm: ReturnType<typeof fakeLlm>;
let song: SongDto;

beforeEach(async () => {
  llm = fakeLlm();
  ({ app, db } = await createTestApp({}, llm.client));
  admin = await setupAdmin(app);
  bob = await createUser(app, admin, 'bob-the-user');
  song = (await call(app, bob, 'POST', '/api/songs', { title: 'Bob private', visibility: 'private' })).json();
  await tick();
});
afterEach(async () => {
  await app.close();
});

const propose = (instruction = 'Make the bass synthetic') =>
  call(app, bob, 'POST', `/api/songs/${song.id}/agent/proposals`, {
    instruction,
    code: song.currentVersion.code,
    baseVersionId: song.currentVersion.id,
  });
const listRuns = async (query = '') =>
  (await call(app, admin, 'GET', `/api/admin/agent/runs${query}`)).json() as AgentRunListDto;
const getRun = async (id: number) =>
  (await call(app, admin, 'GET', `/api/admin/agent/runs/${id}`)).json() as AgentRunDetailDto;
const onlyRun = async () => getRun((await listRuns()).runs[0]!.id);
const auditActions = () =>
  (db.prepare('SELECT action FROM audit_log').all() as unknown as { action: string }[]).map((r) => r.action);

describe('what a run records', () => {
  it('keeps the request, code, answer and token counts, and the system prompt once under its hash', async () => {
    llm.queue.push(answer(), answer());
    await propose();
    await propose('Again');
    const run = (await getRun((await listRuns()).runs[1]!.id)) as AgentRunDetailDto;
    expect(run).toMatchObject({
      purpose: 'song',
      tier: 'fast',
      request: 'Make the bass synthetic',
      inputCode: song.currentVersion.code,
      status: 'ok',
      username: 'bob-the-user',
      songId: song.id,
      flagged: false,
    });
    expect(run.outputCode).toContain('gm_synth_bass_1');
    const [attempt] = run.attempts;
    expect(attempt).toMatchObject({
      number: 1,
      model: 'deepseek/deepseek-v4.1-flash',
      answer: answer(),
      rejection: null,
      finishReason: 'stop',
      promptTokens: 100,
      completionTokens: 50,
      reasoningTokens: 30,
      cachedTokens: 80,
      costUsd: 0.01,
    });
    expect(attempt!.systemPromptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt!.messages.map((m) => m.role)).toEqual(['user']);
    const prompts = db.prepare('SELECT COUNT(*) AS n FROM agent_system_prompts').get() as { n: number };
    expect(prompts.n).toBe(1);
    const prompt = await call(app, admin, 'GET', `/api/admin/agent/prompts/${attempt!.systemPromptHash}`);
    expect(prompt.json().content).toContain('# Strudel reference');
  });

  it('records why an answer was turned down and what the model was told next', async () => {
    llm.queue.push('Sure! Here is your bass.', answer());
    await propose();
    const run = await onlyRun();
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts[0]!.rejection).toBe('The answer is not valid JSON.');
    expect(run.attempts[1]!.rejection).toBeNull();
    expect(run.attempts[1]!.messages.at(-1)!.content).toContain('The answer is not valid JSON.');
    expect(run.attempts[1]!.messages.at(-2)).toEqual({
      role: 'assistant',
      content: 'Sure! Here is your bass.',
    });
    expect((await listRuns()).runs[0]).toMatchObject({ attemptCount: 2, rejectedCount: 1 });
  });

  it('records a failure with what the provider reported', async () => {
    const info = {
      promptTokens: 9000,
      completionTokens: 16000,
      reasoningTokens: 16000,
      cachedTokens: null,
      finishReason: 'length',
    };
    llm.queue.push(new LlmError('The model returned an empty answer', false, 0.12, info));
    const res = await propose();
    expect(res.statusCode).toBe(502);
    const run = await onlyRun();
    expect(run).toMatchObject({ status: 'failed', outputCode: null });
    expect(run.error).toContain('empty answer');
    expect(run.attempts[0]).toMatchObject({
      answer: null,
      error: 'The model returned an empty answer',
      finishReason: 'length',
      reasoningTokens: 16000,
      costUsd: 0.12,
    });
  });

  it('takes accepted and rejected from the proposal', async () => {
    llm.queue.push(answer(), answer());
    const first = (await propose()).json() as AgentProposalDto;
    expect((await onlyRun()).decision).toBe('pending');
    await call(app, bob, 'POST', `/api/songs/${song.id}/agent/proposals/${first.id}/accept`, {});
    expect((await onlyRun()).decision).toBe('accepted');
    const second = (await propose('Other')).json() as AgentProposalDto;
    await call(app, bob, 'POST', `/api/songs/${song.id}/agent/proposals/${second.id}/reject`, {});
    expect((await onlyRun()).decision).toBe('rejected');
    const stored = db.prepare('PRAGMA table_info(agent_runs)').all() as unknown as { name: string }[];
    expect(stored.map((c) => c.name)).not.toContain('decision');
  });

  it('logs chat, compose, repair and explanations', async () => {
    llm.queue.push(JSON.stringify({ reply: 'It is in C major.' }));
    await call(app, bob, 'POST', `/api/songs/${song.id}/agent/chat`, {
      message: 'What key?',
      code: song.currentVersion.code,
      baseVersionId: song.currentVersion.id,
    });
    expect(await onlyRun()).toMatchObject({ purpose: 'chat', request: 'What key?', status: 'ok' });

    llm.queue.push(
      JSON.stringify({
        title: 'Fake',
        summary: 'Composed',
        changes: [{ type: 'add', name: 'drums', code: 's("bd sd").bank("RolandTR909")' }],
      }),
    );
    await call(app, bob, 'POST', '/api/agent/compose', { description: 'A waltz' });
    const composed = await onlyRun();
    expect(composed).toMatchObject({
      purpose: 'compose',
      request: 'A waltz',
      status: 'ok',
      decision: 'pending',
    });
    expect(composed.songId).toEqual(expect.any(Number));
    expect(composed.songTitle).toBe('Fake');

    llm.queue.push(answer());
    const proposal = (await propose()).json() as AgentProposalDto;
    llm.queue.push(answer());
    await call(app, bob, 'POST', `/api/songs/${song.id}/agent/proposals/${proposal.id}/repair`, {
      error: 'unknown sound',
    });
    const repair = await onlyRun();
    expect(repair).toMatchObject({
      purpose: 'repair',
      request: 'Failed in the player: unknown sound',
      proposalId: proposal.id,
    });

    llm.queue.push('An explanation.');
    await call(app, bob, 'POST', `/api/songs/${song.id}/explanations`, { level: 'short', note: 'po polsku' });
    const explained = await onlyRun();
    expect(explained).toMatchObject({
      purpose: 'explain',
      request: 'Explain, level short: po polsku',
      inputCode: song.currentVersion.code,
      status: 'ok',
      outputCode: null,
    });
    expect(explained.attempts[0]!.answer).toBe('An explanation.');
  });

  it('records a stop by a limit as a run with no model calls', async () => {
    db.prepare(
      `INSERT INTO agent_calls (user_id, purpose, model, prompt_tokens, completion_tokens, cost_usd, status, created_at)
       VALUES (?, 'song', 'm/x', 0, 0, 999, 'ok', ?)`,
    ).run(bob.userId, Date.now());
    expect((await propose()).statusCode).toBe(429);
    expect(await onlyRun()).toMatchObject({ status: 'failed', attempts: [] });
  });

  it('never gets in the way of an answer when the log cannot be written', async () => {
    db.exec('DROP TABLE agent_run_attempts; DROP TABLE agent_runs;');
    llm.queue.push(answer());
    const res = await propose();
    expect(res.statusCode).toBe(201);
    expect((res.json() as AgentProposalDto).summary).toBe('Changed the bass');
    llm.queue.push('Text.');
    const explain = await call(app, bob, 'POST', `/api/songs/${song.id}/explanations`, {});
    expect(explain.body).toContain('"type":"done"');
    llm.queue.push(new LlmError('Busy', false));
    expect((await propose()).statusCode).toBe(502);
  });
});

describe('thinking text', () => {
  const secret = 'SECRET-THOUGHTS';
  const usage = {
    prompt_tokens: 10,
    completion_tokens: 5,
    cost: 0.001,
    prompt_tokens_details: { cached_tokens: 7 },
    completion_tokens_details: { reasoning_tokens: 3 },
  };
  const client = (f: typeof fetch) =>
    createOpenRouterClient({
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      publicUrl: 'https://a.test',
      fetch: f,
    });
  const req: ChatRequest = { model: 'm/x', messages: [{ role: 'user', content: 'q' }], maxTokens: 10 };

  it('asks models to leave it out, and reads only the counts of a plain answer', async () => {
    let body: Record<string, unknown> = {};
    const r = await client((async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: 'm/x',
          choices: [
            {
              message: { content: 'hi', reasoning: secret, reasoning_details: [secret] },
              finish_reason: 'stop',
            },
          ],
          usage,
        }),
      );
    }) as typeof fetch).chat(req);
    expect(body.reasoning).toEqual({ exclude: true });
    expect(r).toMatchObject({ content: 'hi', reasoningTokens: 3, cachedTokens: 7, finishReason: 'stop' });
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('reads only the counts of a stream', async () => {
    const lines = [
      { model: 'm/x', choices: [{ delta: { reasoning: secret } }] },
      { model: 'm/x', choices: [{ delta: { content: 'hi' }, finish_reason: 'length' }] },
      { model: 'm/x', choices: [], usage },
    ];
    const r = await client(
      (async () => new Response(lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join(''))) as typeof fetch,
    ).chat({
      ...req,
      onText: () => {},
    });
    expect(r).toMatchObject({ content: 'hi', reasoningTokens: 3, cachedTokens: 7, finishReason: 'length' });
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('keeps the counts of an empty answer, for the log', async () => {
    const err = await client(
      (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: null, reasoning: secret }, finish_reason: 'length' }],
            usage,
          }),
        )) as typeof fetch,
    )
      .chat(req)
      .catch((e: unknown) => e as LlmError);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).info).toMatchObject({ reasoningTokens: 3, finishReason: 'length' });
    expect(JSON.stringify((err as LlmError).info)).not.toContain(secret);
  });
});

describe('admin endpoints', () => {
  it.each([
    ['GET', '/api/admin/agent/runs'],
    ['GET', '/api/admin/agent/runs/export'],
    ['GET', '/api/admin/agent/runs/RUN'],
    ['PATCH', '/api/admin/agent/runs/RUN'],
    ['GET', '/api/admin/agent/prompts/HASH'],
    ['GET', '/api/admin/agent/songs/SONG/history'],
    ['GET', '/api/admin/agent/songs/SONG/export'],
  ] as const)('%s %s is for the admin only', async (method, path) => {
    llm.queue.push(answer());
    await propose();
    const run = await onlyRun();
    const url = path
      .replace('RUN', String(run.id))
      .replace('HASH', run.attempts[0]!.systemPromptHash!)
      .replace('SONG', String(song.id));
    const body = method === 'PATCH' ? { flagged: true } : undefined;
    expect((await call(app, null, method, url, body)).statusCode).toBe(401);
    expect((await call(app, bob, method, url, body)).statusCode).toBe(403);
    expect((await call(app, admin, method, url, body)).statusCode).toBe(200);
  });

  it('marks runs and keeps a note', async () => {
    llm.queue.push(answer());
    await propose();
    const { id } = await onlyRun();
    const patch = (body: unknown) => call(app, admin, 'PATCH', `/api/admin/agent/runs/${id}`, body);
    expect((await patch({ flagged: true })).statusCode).toBe(200);
    expect((await patch({ note: '  too busy  ' })).statusCode).toBe(200);
    expect(await getRun(id)).toMatchObject({ flagged: true, note: 'too busy' });
    expect((await patch({ flagged: false })).statusCode).toBe(200);
    expect(await getRun(id)).toMatchObject({ flagged: false, note: 'too busy' });
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ note: 'x'.repeat(2001) })).statusCode).toBe(400);
    expect((await patch({ request: 'changed' })).statusCode).toBe(400);
    expect((await call(app, admin, 'PATCH', '/api/admin/agent/runs/99999', { note: 'x' })).statusCode).toBe(
      404,
    );
  });

  it('filters and pages the list', async () => {
    llm.queue.push(answer(), answer());
    await propose();
    await propose('Second');
    const { runs, total } = await listRuns();
    expect(total).toBe(2);
    expect(runs[0]!.request).toBe('Second');
    await call(app, admin, 'PATCH', `/api/admin/agent/runs/${runs[1]!.id}`, { flagged: true });
    expect((await listRuns('?flagged=1')).runs.map((r) => r.id)).toEqual([runs[1]!.id]);
    expect((await listRuns(`?songId=${song.id}&offset=1`)).runs).toHaveLength(1);
    expect((await listRuns('?songId=99999')).total).toBe(0);
    expect((await call(app, admin, 'GET', '/api/admin/agent/runs?offset=-1')).statusCode).toBe(400);
  });

  it('shows one song in order, with versions and changes by hand', async () => {
    llm.queue.push(answer());
    const proposal = (await propose()).json() as AgentProposalDto;
    await tick();
    const accepted = await call(
      app,
      bob,
      'POST',
      `/api/songs/${song.id}/agent/proposals/${proposal.id}/accept`,
      {},
    );
    const agentVersion = accepted.json().version as { id: number; code: string };
    await tick();
    const handCode = `${agentVersion.code}\n// edited by hand`;
    await call(app, bob, 'POST', `/api/songs/${song.id}/versions`, {
      baseVersionId: agentVersion.id,
      code: handCode,
      message: 'My fix',
    });
    await tick();
    llm.queue.push(answer());
    // The next request carries edits that were not saved.
    await call(app, bob, 'POST', `/api/songs/${song.id}/agent/proposals`, {
      instruction: 'Next',
      code: `${handCode}\n// not saved`,
      baseVersionId: agentVersion.id,
    });

    const res = await call(app, admin, 'GET', `/api/admin/agent/songs/${song.id}/history`);
    expect(res.statusCode).toBe(200);
    const history = res.json() as AgentSongHistoryDto;
    expect(history.song.title).toBe('Bob private');
    const steps = history.events.map((e) =>
      e.kind === 'run'
        ? `run:${e.run.request}:${e.editedSinceLastVersion}`
        : `v${e.version.number}:${e.version.authorKind}`,
    );
    expect(steps).toEqual([
      'v1:user',
      'run:Make the bass synthetic:false',
      'v2:agent',
      'v3:user',
      'run:Next:true',
    ]);
    const times = history.events.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(auditActions()).toContain('agent.history_viewed');
  });

  it('downloads a song without user names, in a form that can be replayed', async () => {
    llm.queue.push(answer());
    await propose();
    const res = await call(app, admin, 'GET', `/api/admin/agent/songs/${song.id}/export`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="s-maker-song-\d+-history-.*\.json"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toContain('bob-the-user');
    expect(res.body).not.toContain('username');
    expect(res.body).not.toContain('"admin"');
    const file = agentRunsExportSchema.parse(res.json()) as AgentRunsExport;
    expect(file).toMatchObject({ kind: 'song', song: { title: 'Bob private' } });
    expect(file.events.map((e) => e.kind)).toEqual(['version', 'run']);
    expect(auditActions()).toContain('agent.runs_exported');
    const audit = db.prepare(`SELECT details FROM audit_log WHERE action = 'agent.runs_exported'`).get() as {
      details: string;
    };
    expect(JSON.parse(audit.details)).toEqual({ kind: 'song', songId: song.id, events: 2 });

    const [task] = replayTasksFrom(res.json());
    expect(task).toMatchObject({ purpose: 'song', tier: 'fast', baseCode: song.currentVersion.code });
    expect(task!.messages[0]!.role).toBe('system');
    expect(task!.messages[0]!.content).toContain('# Strudel reference');
    expect(task!.messages[1]!.content).toContain('# REQUEST');
    expect(task!.original.decision).toBe('pending');
  });

  it('downloads only the marked runs', async () => {
    llm.queue.push(answer(), answer());
    await propose('Keep me');
    await propose('Not me');
    const { runs } = await listRuns();
    await call(app, admin, 'PATCH', `/api/admin/agent/runs/${runs[1]!.id}`, { flagged: true, note: 'good' });
    const res = await call(app, admin, 'GET', '/api/admin/agent/runs/export');
    expect(res.headers['content-disposition']).toMatch(/s-maker-marked-runs-/);
    expect(res.body).not.toContain('bob-the-user');
    const tasks = replayTasksFrom(res.json());
    expect(tasks.map((t) => t.request)).toEqual(['Keep me']);
    expect((res.json() as AgentRunsExport).events[0]).toMatchObject({ run: { note: 'good', flagged: true } });
  });

  it('does not open up a song the agent never worked on', async () => {
    const other = (
      await call(app, bob, 'POST', '/api/songs', { title: 'Hidden', visibility: 'private' })
    ).json();
    for (const part of ['history', 'export'])
      expect((await call(app, admin, 'GET', `/api/admin/agent/songs/${other.id}/${part}`)).statusCode).toBe(
        404,
      );
  });

  it('rejects a file that is not an export, or lacks its prompt', async () => {
    expect(() => replayTasksFrom({ runs: [] })).toThrow();
    llm.queue.push(answer());
    await propose();
    const file = (
      await call(app, admin, 'GET', `/api/admin/agent/songs/${song.id}/export`)
    ).json() as AgentRunsExport;
    expect(() => replayTasksFrom({ ...file, systemPrompts: {} })).toThrow(/system prompt/);
  });
});

describe('what happens to old runs', () => {
  const DAY = 24 * 3600 * 1000;

  it('deletes runs nobody marked after 90 days, with prompts nothing uses', async () => {
    llm.queue.push(answer(), answer(), answer());
    await propose('Old');
    await propose('Old but marked');
    await propose('Recent');
    const { runs } = await listRuns();
    const [recent, marked, old] = runs;
    await call(app, admin, 'PATCH', `/api/admin/agent/runs/${marked!.id}`, { flagged: true });
    const longAgo = Date.now() - 91 * DAY;
    db.prepare('UPDATE agent_runs SET created_at = ? WHERE id IN (?, ?)').run(longAgo, old!.id, marked!.id);
    db.prepare('UPDATE agent_runs SET created_at = ? WHERE id = ?').run(Date.now() - 89 * DAY, recent!.id);

    expect(agentRuns.deleteOld(db)).toBe(1);
    expect((await listRuns()).runs.map((r) => r.id)).toEqual([recent!.id, marked!.id]);
    const attempts = db.prepare('SELECT COUNT(*) AS n FROM agent_run_attempts').get() as { n: number };
    expect(attempts.n).toBe(2);
    const prompts = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM agent_system_prompts').get() as { n: number }).n;
    expect(prompts()).toBe(1);

    db.exec('DELETE FROM agent_runs');
    agentRuns.deleteOld(db);
    expect(prompts()).toBe(0);
  });

  it('deletes the runs of a deleted song, marked ones too', async () => {
    llm.queue.push(answer());
    await propose();
    const { id } = await onlyRun();
    await call(app, admin, 'PATCH', `/api/admin/agent/runs/${id}`, { flagged: true });
    expect((await call(app, bob, 'DELETE', `/api/songs/${song.id}`)).statusCode).toBe(200);
    expect((await listRuns()).total).toBe(0);
  });
});
