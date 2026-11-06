import {
  agentProposeRequestSchema,
  agentRepairRequestSchema,
  agentSettingsSchema,
  type AgentAdminDto,
  type AgentProposalDto,
  type AgentUsageDto,
  type ModelTier,
  type MusicBrief,
  type SongDto,
  type VersionDto,
} from '@s-maker/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAdmin, requireUser } from '../auth/plugin';
import { audit } from '../auth/store';
import { badRequest, conflict, forbidden, HttpError, notFound, parse } from '../http-error';
import { canEdit, canView, songs, versions } from '../songs/store';
import { proposeMessages, repairMessage } from './prompt';
import { runAgent } from './service';
import { agentCalls, agentSettings, proposalDto, proposals } from './store';

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
            }),
          },
        ),
      );
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
