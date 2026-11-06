import { PassThrough } from 'node:stream';
import {
  agentChatRequestSchema,
  agentProposeRequestSchema,
  agentRepairRequestSchema,
  agentSettingsSchema,
  composeRequestSchema,
  partialJsonString,
  type AgentAdminDto,
  type AgentChatDto,
  type AgentProposalDto,
  type AgentStreamEvent,
  type AgentUsageDto,
  type ModelTier,
  type MusicBrief,
  type SongDto,
  type VersionDto,
} from '@s-maker/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAdmin, requireUser } from '../auth/plugin';
import { audit } from '../auth/store';
import { badRequest, conflict, forbidden, HttpError, notFound, parse } from '../http-error';
import { canEdit, canView, songs, versions } from '../songs/store';
import { chatMessages, composeMessages, proposeMessages, repairMessage } from './prompt';
import { runAgent } from './service';
import { agentCalls, agentChat, agentSettings, proposalDto, proposals } from './store';

const songParams = z.object({ id: z.coerce.number().int().positive() });
const proposalParams = songParams.extend({ proposalId: z.coerce.number().int().positive() });
const agentRateLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

/** The agent changes songs, so only the owner can use it on one. */
export function ownSong(request: FastifyRequest, id: number) {
  const user = currentUser(request);
  const song = songs.byId(request.server.db, id);
  if (!song || !canView(song, user)) throw notFound('Song not found');
  if (!canEdit(song, user))
    throw forbidden('Only the owner can use the agent on this song. Make a copy first.');
  return { song, user };
}

export const parseBrief = (brief: string | null) => (brief ? (JSON.parse(brief) as MusicBrief) : null);

/** One request per user at a time: protects the budget from double clicks and parallel tabs. */
const running = new Set<number>();
export async function oneAtATime<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  if (running.has(userId)) throw conflict('The agent is still working on your previous request.');
  running.add(userId);
  try {
    return await fn();
  } finally {
    running.delete(userId);
  }
}

/** The empty song that a composition starts from. */
const COMPOSE_BASE_CODE = 'setcpm(120/4)\n';

/** How often a long wait says it is still alive, so that proxies do not close the connection. */
const HEARTBEAT_MS = 10_000;

/**
 * Answers with one JSON object per line while the work runs. Problems found before this point are ordinary
 * HTTP errors; later ones are 'error' events. Closing the connection cancels the model call.
 */
export function streamEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  work: (send: (event: AgentStreamEvent) => void, signal: AbortSignal) => Promise<void>,
): FastifyReply {
  const stream = new PassThrough();
  const abort = new AbortController();
  const send = (event: AgentStreamEvent) => {
    if (!stream.writableEnded) stream.write(`${JSON.stringify(event)}\n`);
  };
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) abort.abort();
  });
  const heartbeat = setInterval(() => send({ type: 'status', text: 'The agent is working…' }), HEARTBEAT_MS);
  work(send, abort.signal)
    .catch((e: unknown) => {
      if (e instanceof HttpError) send({ type: 'error', error: e.message });
      else {
        request.log.error(e);
        send({ type: 'error', error: 'Something went wrong' });
      }
    })
    .finally(() => {
      clearInterval(heartbeat);
      stream.end();
    });
  return reply
    .type('application/x-ndjson')
    .header('Cache-Control', 'no-store')
    .header('X-Accel-Buffering', 'no')
    .send(stream);
}

/** Sends text as it arrives, as the part that is new. */
export function textStreamer(send: (event: AgentStreamEvent) => void, read = (raw: string) => raw) {
  let sent = '';
  return (textSoFar: string) => {
    const text = read(textSoFar);
    if (text.startsWith(sent)) {
      if (text.length > sent.length) send({ type: 'delta', text: text.slice(sent.length) });
    } else {
      // Another attempt began.
      send({ type: 'reset' });
      if (text) send({ type: 'delta', text });
    }
    sent = text;
  };
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  app.addHook('preHandler', requireUser);

  app.get('/api/agent/usage', async (request): Promise<AgentUsageDto> => {
    return agentCalls.usage(db, currentUser(request).id, agentSettings.get(db, app.config), app.llm.enabled);
  });

  app.post(
    '/api/songs/:id/agent/proposals',
    { config: agentRateLimit },
    async (request, reply): Promise<AgentProposalDto> => {
      const { id } = parse(songParams, request.params);
      const { song, user } = ownSong(request, id);
      const body = parse(agentProposeRequestSchema, request.body);
      const result = await oneAtATime(user.id, () =>
        runAgent(
          { app, userId: user.id, songId: song.id, purpose: body.track ? 'track' : 'song' },
          {
            baseCode: body.code,
            tier: body.tier,
            messages: proposeMessages({
              code: body.code,
              brief: parseBrief(song.brief),
              instruction: body.instruction,
              ...(body.track ? { track: body.track } : {}),
              ...(body.section ? { section: body.section } : {}),
            }),
          },
        ),
      );
      proposals.closePending(db, song.id, user.id);
      const row = proposals.create(db, {
        songId: song.id,
        userId: user.id,
        baseVersionId: body.baseVersionId,
        instruction: body.instruction,
        track: body.track ?? null,
        tier: body.tier,
        summary: result.answer.summary,
        baseCode: body.code,
        code: result.code,
        brief: result.answer.brief ?? null,
        model: result.model,
        costUsd: result.costUsd,
      });
      reply.status(201);
      return proposalDto(row);
    },
  );

  app.get('/api/songs/:id/agent/chat', async (request): Promise<AgentChatDto> => {
    const { id } = parse(songParams, request.params);
    const { song, user } = ownSong(request, id);
    const pending = proposals.pending(db, song.id, user.id);
    return {
      messages: agentChat.list(db, song.id, user.id),
      pending: pending ? proposalDto(pending) : null,
    };
  });

  /** A message in the chat. A change comes back as an ordinary proposal to try, accept or reject. */
  app.post('/api/songs/:id/agent/chat', { config: agentRateLimit }, async (request, reply) => {
    const { id } = parse(songParams, request.params);
    const { song, user } = ownSong(request, id);
    const body = parse(agentChatRequestSchema, request.body);
    return streamEvents(request, reply, (send, signal) =>
      oneAtATime(user.id, async () => {
        send({ type: 'status', text: 'The agent is working…' });
        const history = agentChat
          .list(db, song.id, user.id, 12)
          .map((m) => ({ role: m.role, content: m.content }));
        const brief = parseBrief(song.brief);
        agentChat.add(db, { songId: song.id, userId: user.id, role: 'user', content: body.message });
        const result = await runAgent(
          { app, userId: user.id, songId: song.id, purpose: 'chat' },
          {
            baseCode: body.code,
            tier: body.tier,
            messages: chatMessages({ code: body.code, brief, message: body.message, history }),
            onText: textStreamer(send, (raw) => partialJsonString(raw, 'reply') ?? ''),
            signal,
          },
        );
        let proposal: AgentProposalDto | null = null;
        let newBrief = null;
        if (result.code !== body.code) {
          proposals.closePending(db, song.id, user.id);
          proposal = proposalDto(
            proposals.create(db, {
              songId: song.id,
              userId: user.id,
              baseVersionId: body.baseVersionId,
              instruction: body.message,
              track: null,
              tier: body.tier,
              summary: result.answer.summary,
              baseCode: body.code,
              code: result.code,
              brief: result.answer.brief ?? null,
              model: result.model,
              costUsd: result.costUsd,
            }),
          );
        } else if (result.answer.brief) {
          // Nothing to accept: the decision is the result of this message.
          newBrief = { ...brief, ...result.answer.brief };
          songs.update(db, song.id, { brief: newBrief });
        }
        const message = agentChat.add(db, {
          songId: song.id,
          userId: user.id,
          role: 'assistant',
          content: result.answer.reply ?? result.answer.summary,
          proposalId: proposal?.id ?? null,
        });
        send({ type: 'done', message, proposal, brief: newBrief });
      }),
    );
  });

  /** Writes a new song from a description and/or a Music Brief. The song exists only if this succeeds. */
  app.post('/api/agent/compose', { config: agentRateLimit }, async (request, reply) => {
    const user = currentUser(request);
    const body = parse(composeRequestSchema, request.body);
    return streamEvents(request, reply, (send, signal) =>
      oneAtATime(user.id, async () => {
        send({ type: 'status', text: 'The agent is composing…' });
        const result = await runAgent(
          { app, userId: user.id, songId: null, purpose: 'compose' },
          {
            baseCode: COMPOSE_BASE_CODE,
            tier: body.tier,
            messages: composeMessages({ description: body.description, brief: body.brief }),
            signal,
          },
        );
        if (result.code === COMPOSE_BASE_CODE) throw new HttpError(422, result.answer.summary);
        const created = songs.create(db, {
          ownerId: user.id,
          title: body.title || result.answer.title || 'New song',
          visibility: 'private',
          code: COMPOSE_BASE_CODE,
          brief: { ...body.brief, ...result.answer.brief },
        });
        const dto = songs.dto(db, created, user);
        const proposal = proposals.create(db, {
          songId: created.id,
          userId: user.id,
          baseVersionId: dto.currentVersion.id,
          instruction: body.description || 'Compose a song from the brief',
          track: null,
          tier: body.tier,
          summary: result.answer.summary,
          baseCode: COMPOSE_BASE_CODE,
          code: result.code,
          brief: null,
          model: result.model,
          costUsd: result.costUsd,
        });
        if (body.description)
          agentChat.add(db, {
            songId: created.id,
            userId: user.id,
            role: 'user',
            content: body.description,
          });
        agentChat.add(db, {
          songId: created.id,
          userId: user.id,
          role: 'assistant',
          content: result.answer.summary,
          proposalId: proposal.id,
        });
        audit.log(db, 'agent.composed', {
          userId: user.id,
          ip: request.ip,
          details: { songId: created.id, proposalId: proposal.id },
        });
        send({ type: 'done', songId: created.id });
      }),
    );
  });

  /** The proposal failed when tried in the player: give the model the error. */
  app.post(
    '/api/songs/:id/agent/proposals/:proposalId/repair',
    { config: agentRateLimit },
    async (request): Promise<AgentProposalDto> => {
      const { id, proposalId } = parse(proposalParams, request.params);
      const { song, user } = ownSong(request, id);
      const row = proposals.get(db, song.id, user.id, proposalId);
      if (!row) throw notFound('Proposal not found');
      if (row.status !== 'pending') throw conflict('This proposal is already closed');
      if (row.repairs >= 2) throw new HttpError(422, 'The agent could not fix this proposal');
      const { error } = parse(agentRepairRequestSchema, request.body);
      const messages = [
        ...proposeMessages({
          code: row.base_code,
          brief: parseBrief(song.brief),
          instruction: row.instruction,
          ...(row.track ? { track: row.track } : {}),
        }),
        {
          role: 'assistant' as const,
          content: JSON.stringify({
            summary: row.summary,
            note: 'previous attempt, full code below',
            code: row.code,
          }),
        },
        repairMessage(`In the player it failed with: ${error}`),
      ];
      const result = await oneAtATime(user.id, () =>
        runAgent(
          { app, userId: user.id, songId: song.id, purpose: 'repair' },
          { baseCode: row.base_code, tier: row.tier as ModelTier, messages },
        ),
      );
      proposals.updateAfterRepair(db, row.id, {
        code: result.code,
        summary: result.answer.summary,
        brief: result.answer.brief ?? null,
        model: result.model,
        addCost: result.costUsd,
      });
      return proposalDto(proposals.get(db, song.id, user.id, row.id)!);
    },
  );

  /** Saves the proposal as a new version, marked as written by the agent. */
  app.post(
    '/api/songs/:id/agent/proposals/:proposalId/accept',
    async (request, reply): Promise<{ version: VersionDto; song: SongDto }> => {
      const { id, proposalId } = parse(proposalParams, request.params);
      const { song, user } = ownSong(request, id);
      const row = proposals.get(db, song.id, user.id, proposalId);
      if (!row) throw notFound('Proposal not found');
      if (row.status !== 'pending') throw conflict('This proposal is already closed');
      const version = versions.add(db, song.id, {
        baseVersionId: row.base_version_id,
        authorId: user.id,
        authorKind: 'agent',
        message: row.summary.slice(0, 200),
        code: row.code,
      });
      if (!version)
        throw conflict('This song was saved somewhere else in the meantime. Reload and ask the agent again.');
      proposals.setStatus(db, row.id, 'accepted');
      const changedBrief = row.brief ? (JSON.parse(row.brief) as MusicBrief) : null;
      if (changedBrief) songs.update(db, song.id, { brief: { ...parseBrief(song.brief), ...changedBrief } });
      audit.log(db, 'agent.accepted', {
        userId: user.id,
        ip: request.ip,
        details: { songId: song.id, proposalId: row.id, versionId: version.id },
      });
      reply.status(201);
      return { version, song: songs.dto(db, songs.byId(db, song.id)!, user) };
    },
  );

  app.post('/api/songs/:id/agent/proposals/:proposalId/reject', async (request) => {
    const { id, proposalId } = parse(proposalParams, request.params);
    const { song, user } = ownSong(request, id);
    const row = proposals.get(db, song.id, user.id, proposalId);
    if (!row) throw notFound('Proposal not found');
    if (row.status === 'pending') proposals.setStatus(db, row.id, 'rejected');
    return { ok: true };
  });

  // ---------- admin ----------

  app.get('/api/admin/agent', { preHandler: requireAdmin }, async (): Promise<AgentAdminDto> => {
    return {
      enabled: app.llm.enabled,
      settings: agentSettings.get(db, app.config),
      spending: agentCalls.spending(db),
      totalUsd: agentCalls.spentTotal(db),
      recent: agentCalls.recent(db),
    };
  });

  app.put('/api/admin/agent/settings', { preHandler: requireAdmin }, async (request) => {
    const settings = parse(agentSettingsSchema, request.body);
    // A typo in a model id would only show up later as failing requests, so check now.
    if (app.llm.enabled) {
      const known = new Set(await app.llm.listModels());
      for (const m of [settings.modelFast, settings.modelStrong, settings.modelFallback]) {
        if (m && !known.has(m)) throw badRequest(`OpenRouter has no model "${m}"`);
      }
    }
    agentSettings.set(db, settings);
    audit.log(db, 'agent.settings', {
      userId: currentUser(request).id,
      ip: request.ip,
      details: { ...settings },
    });
    return settings;
  });
}
