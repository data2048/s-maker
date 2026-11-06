// Admin only: reading the logs of agent runs and downloading them. Every route in this plugin needs the admin.
import { AGENT_RUNS_PAGE_SIZE, agentRunPatchSchema, type AgentRunListDto } from '@s-maker/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth/plugin';
import { audit } from '../auth/store';
import { notFound, parse } from '../http-error';
import { agentRuns } from './runs';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const hashParams = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/) });
const listQuery = z.object({
  flagged: z.enum(['1']).optional(),
  songId: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function agentRunRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);
  // These answers hold requests and code from private songs: no copies in any cache.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  const auditRead = (request: FastifyRequest, action: string, details: Record<string, unknown>) =>
    audit.log(db, action, { userId: currentUser(request).id, ip: request.ip, details });

  const download = (reply: FastifyReply, name: string, body: unknown) =>
    reply
      .type('application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(JSON.stringify(body, null, 2));
  const today = () => new Date().toISOString().slice(0, 10);

  app.get('/api/admin/agent/runs', async (request): Promise<AgentRunListDto & { pageSize: number }> => {
    const q = parse(listQuery, request.query);
    return {
      ...agentRuns.list(db, {
        ...(q.flagged ? { flagged: true } : {}),
        ...(q.songId ? { songId: q.songId } : {}),
        offset: q.offset,
      }),
      pageSize: AGENT_RUNS_PAGE_SIZE,
    };
  });

  app.get('/api/admin/agent/runs/export', async (request, reply) => {
    const file = agentRuns.exportMarked(db);
    auditRead(request, 'agent.runs_exported', { kind: 'marked', events: file.events.length });
    return download(reply, `s-maker-marked-runs-${today()}.json`, file);
  });

  app.get('/api/admin/agent/runs/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const run = agentRuns.detail(db, id);
    if (!run) throw notFound('Run not found');
    auditRead(request, 'agent.run_viewed', { runId: id });
    return run;
  });

  app.patch('/api/admin/agent/runs/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const patch = parse(agentRunPatchSchema, request.body);
    if (!agentRuns.update(db, id, patch)) throw notFound('Run not found');
    return { ok: true };
  });

  app.get('/api/admin/agent/prompts/:hash', async (request) => {
    const { hash } = parse(hashParams, request.params);
    const content = agentRuns.systemPrompt(db, hash);
    if (content === null) throw notFound('Prompt not found');
    return { hash, content };
  });

  app.get('/api/admin/agent/songs/:id/history', async (request) => {
    const { id } = parse(idParams, request.params);
    const history = agentRuns.songHistory(db, id);
    if (!history) throw notFound('No agent runs for this song');
    auditRead(request, 'agent.history_viewed', { songId: id });
    return history;
  });

  app.get('/api/admin/agent/songs/:id/export', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const file = agentRuns.exportSong(db, id);
    if (!file) throw notFound('No agent runs for this song');
    auditRead(request, 'agent.runs_exported', { kind: 'song', songId: id, events: file.events.length });
    return download(reply, `s-maker-song-${id}-history-${today()}.json`, file);
  });
}
