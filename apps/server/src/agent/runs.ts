// Logs of agent runs, for finding out why results were poor and for trying other models on the same requests.
// Admin only: these rows hold requests and code from private songs too.
import { createHash } from 'node:crypto';
import {
  AGENT_RUN_RETENTION_DAYS,
  AGENT_RUNS_PAGE_SIZE,
  agentRunsExportSchema,
  type AgentHistoryEventDto,
  type AgentHistoryVersion,
  type AgentRunAttemptDto,
  type AgentRunDetailDto,
  type AgentRunListDto,
  type AgentRunsExport,
  type AgentRunStatus,
  type AgentSongHistoryDto,
  type AgentRunSummaryDto,
} from '@s-maker/shared';
import type { FastifyInstance } from 'fastify';
import { transaction, type Db } from '../db';
import type { ChatMessage } from './openrouter';

const iso = (ms: number) => new Date(ms).toISOString();
const DAY_MS = 24 * 3600 * 1000;
/** A generous cap on one downloaded file. */
const MAX_EXPORTED_RUNS = 1000;
/** Only code sent from the editor can differ from the saved version because of edits by hand. */
const EDITOR_PURPOSES = new Set(['song', 'track', 'chat']);

/** The log must never get in the way of an answer: a failure here only goes to the server log. */
export function quietly<T>(app: FastifyInstance, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    app.log.error({ err }, 'could not write the agent run log');
    return null;
  }
}

export interface AttemptLog {
  model: string;
  messages: ChatMessage[];
  answer?: string | null;
  error?: string | null;
  finishReason?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  costUsd: number;
  durationMs: number;
}

interface RunRow {
  id: number;
  created_at: number;
  finished_at: number | null;
  username: string | null;
  song_id: number | null;
  song_title: string | null;
  proposal_id: number | null;
  purpose: string;
  tier: string;
  request: string;
  input_code: string | null;
  output_code: string | null;
  status: AgentRunStatus;
  error: string | null;
  decision: 'pending' | 'accepted' | 'rejected' | null;
  flagged: number;
  note: string;
}

interface AttemptRow {
  run_id: number;
  number: number;
  created_at: number;
  model: string;
  system_prompt_hash: string | null;
  messages: string;
  answer: string | null;
  rejection: string | null;
  error: string | null;
  finish_reason: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  cost_usd: number;
  duration_ms: number;
}

const RUN_SELECT = `
  SELECT r.id, r.created_at, r.finished_at, u.username AS username, r.song_id, s.title AS song_title,
         r.proposal_id, r.purpose, r.tier, r.request, r.input_code, r.output_code, r.status, r.error,
         p.status AS decision, r.flagged, r.note
  FROM agent_runs r
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN songs s ON s.id = r.song_id
  LEFT JOIN agent_proposals p ON p.id = r.proposal_id`;

const attemptDto = (a: AttemptRow): AgentRunAttemptDto => ({
  number: a.number,
  at: iso(a.created_at),
  model: a.model,
  systemPromptHash: a.system_prompt_hash,
  messages: JSON.parse(a.messages) as ChatMessage[],
  answer: a.answer,
  rejection: a.rejection,
  error: a.error,
  finishReason: a.finish_reason,
  promptTokens: a.prompt_tokens,
  completionTokens: a.completion_tokens,
  reasoningTokens: a.reasoning_tokens,
  cachedTokens: a.cached_tokens,
  costUsd: a.cost_usd,
  durationMs: a.duration_ms,
});

const runDto = (r: RunRow, attempts: AttemptRow[]): AgentRunDetailDto => ({
  id: r.id,
  at: iso(r.created_at),
  finishedAt: r.finished_at === null ? null : iso(r.finished_at),
  username: r.username,
  songId: r.song_id,
  songTitle: r.song_title,
  proposalId: r.proposal_id,
  purpose: r.purpose,
  tier: r.tier,
  request: r.request,
  inputCode: r.input_code,
  outputCode: r.output_code,
  status: r.status,
  error: r.error,
  decision: r.decision,
  flagged: r.flagged === 1,
  note: r.note,
  attempts: attempts.map(attemptDto),
});

/** Runs with their attempts, oldest first. */
function loadRuns(db: Db, rows: RunRow[]): AgentRunDetailDto[] {
  const attempts = db.prepare('SELECT * FROM agent_run_attempts WHERE run_id = ? ORDER BY number');
  return rows.map((r) => runDto(r, attempts.all(r.id) as unknown as AttemptRow[]));
}

function exportFile(
  db: Db,
  kind: AgentRunsExport['kind'],
  song: AgentSongHistoryDto['song'] | null,
  events: AgentHistoryEventDto[],
): AgentRunsExport {
  const hashes = new Set(
    events.flatMap((e) => (e.kind === 'run' ? e.run.attempts.map((a) => a.systemPromptHash) : [])),
  );
  const systemPrompts: Record<string, string> = {};
  for (const hash of hashes) {
    if (hash === null) continue;
    const content = agentRuns.systemPrompt(db, hash);
    if (content !== null) systemPrompts[hash] = content;
  }
  // The schema keeps only the fields it names: this is what removes user names.
  return agentRunsExportSchema.parse({
    format: 's-maker-agent-runs',
    version: 1,
    exportedAt: new Date().toISOString(),
    kind,
    song,
    systemPrompts,
    events,
  });
}

export const agentRuns = {
  start(
    db: Db,
    r: {
      userId: number;
      songId: number | null;
      proposalId: number | null;
      purpose: string;
      tier: string;
      request: string;
      inputCode: string | null;
    },
  ): number {
    const result = db
      .prepare(
        `INSERT INTO agent_runs (user_id, song_id, proposal_id, purpose, tier, request, input_code, status,
                                 created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(r.userId, r.songId, r.proposalId, r.purpose, r.tier, r.request, r.inputCode, Date.now());
    return Number(result.lastInsertRowid);
  },

  /** The long system prompt is stored once, under its hash. Returns the attempt's id. */
  addAttempt(db: Db, runId: number, a: AttemptLog): number {
    const [first, ...rest] = a.messages;
    const system = first?.role === 'system' ? first.content : null;
    const others = system === null ? a.messages : rest;
    return transaction(db, () => {
      const now = Date.now();
      let hash: string | null = null;
      if (system !== null) {
        hash = createHash('sha256').update(system).digest('hex');
        db.prepare(
          `INSERT INTO agent_system_prompts (hash, content, created_at) VALUES (?, ?, ?)
           ON CONFLICT(hash) DO NOTHING`,
        ).run(hash, system, now);
      }
      const { n } = db
        .prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM agent_run_attempts WHERE run_id = ?')
        .get(runId) as { n: number };
      const result = db
        .prepare(
          `INSERT INTO agent_run_attempts (run_id, number, model, system_prompt_hash, messages, answer, error,
             finish_reason, prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, cost_usd,
             duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          n,
          a.model,
          hash,
          JSON.stringify(others),
          a.answer ?? null,
          a.error ?? null,
          a.finishReason ?? null,
          a.promptTokens ?? null,
          a.completionTokens ?? null,
          a.reasoningTokens ?? null,
          a.cachedTokens ?? null,
          a.costUsd,
          a.durationMs,
          now,
        );
      return Number(result.lastInsertRowid);
    });
  },

  rejectAttempt(db: Db, attemptId: number, reason: string): void {
    db.prepare('UPDATE agent_run_attempts SET rejection = ? WHERE id = ?').run(reason, attemptId);
  },

  finish(
    db: Db,
    runId: number,
    r: { status: AgentRunStatus; outputCode?: string | null; error?: string | null },
  ): void {
    db.prepare(
      'UPDATE agent_runs SET status = ?, output_code = ?, error = ?, finished_at = ? WHERE id = ?',
    ).run(r.status, r.outputCode ?? null, r.error ?? null, Date.now(), runId);
  },

  /** Ties a run to what it produced. A composed song exists only after its run. */
  link(db: Db, runId: number, l: { songId?: number; proposalId?: number }): void {
    db.prepare(
      `UPDATE agent_runs SET song_id = COALESCE(?, song_id), proposal_id = COALESCE(?, proposal_id)
       WHERE id = ?`,
    ).run(l.songId ?? null, l.proposalId ?? null, runId);
  },

  list(db: Db, filter: { flagged?: boolean; songId?: number; offset?: number } = {}): AgentRunListDto {
    const where: string[] = [];
    const params: number[] = [];
    if (filter.flagged) where.push('r.flagged = 1');
    if (filter.songId !== undefined) {
      where.push('r.song_id = ?');
      params.push(filter.songId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM agent_runs r ${clause}`).get(...params) as {
      n: number;
    };
    const rows = db
      .prepare(
        `SELECT r.id, r.created_at, u.username AS username, r.song_id, s.title AS song_title, r.purpose, r.tier,
           SUBSTR(r.request, 1, 300) AS request, r.status, r.error, p.status AS decision, r.flagged, r.note,
           COUNT(a.id) AS attempt_count, COUNT(a.rejection) AS rejected_count,
           (SELECT model FROM agent_run_attempts l WHERE l.run_id = r.id ORDER BY l.number DESC LIMIT 1) AS model,
           COALESCE(SUM(a.prompt_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(a.completion_tokens), 0) AS completion_tokens,
           COALESCE(SUM(a.reasoning_tokens), 0) AS reasoning_tokens,
           COALESCE(SUM(a.cached_tokens), 0) AS cached_tokens,
           COALESCE(SUM(a.cost_usd), 0) AS cost_usd,
           COALESCE(SUM(a.duration_ms), 0) AS duration_ms
         FROM agent_runs r
         LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN songs s ON s.id = r.song_id
         LEFT JOIN agent_proposals p ON p.id = r.proposal_id
         LEFT JOIN agent_run_attempts a ON a.run_id = r.id
         ${clause}
         GROUP BY r.id ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, AGENT_RUNS_PAGE_SIZE, filter.offset ?? 0) as unknown as (Omit<
      RunRow,
      'finished_at' | 'proposal_id' | 'input_code' | 'output_code'
    > & {
      attempt_count: number;
      rejected_count: number;
      model: string | null;
      prompt_tokens: number;
      completion_tokens: number;
      reasoning_tokens: number;
      cached_tokens: number;
      cost_usd: number;
      duration_ms: number;
    })[];
    const runs: AgentRunSummaryDto[] = rows.map((r) => ({
      id: r.id,
      at: iso(r.created_at),
      username: r.username,
      songId: r.song_id,
      songTitle: r.song_title,
      purpose: r.purpose,
      tier: r.tier,
      request: r.request,
      status: r.status,
      error: r.error,
      decision: r.decision,
      flagged: r.flagged === 1,
      note: r.note,
      attemptCount: r.attempt_count,
      rejectedCount: r.rejected_count,
      model: r.model,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      reasoningTokens: r.reasoning_tokens,
      cachedTokens: r.cached_tokens,
      costUsd: r.cost_usd,
      durationMs: r.duration_ms,
    }));
    return { runs, total: n };
  },

  detail(db: Db, id: number): AgentRunDetailDto | null {
    const row = db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(id) as unknown as RunRow | undefined;
    return row ? loadRuns(db, [row])[0]! : null;
  },

  update(db: Db, id: number, patch: { flagged?: boolean | undefined; note?: string | undefined }): boolean {
    const result = db
      .prepare('UPDATE agent_runs SET flagged = COALESCE(?, flagged), note = COALESCE(?, note) WHERE id = ?')
      .run(patch.flagged === undefined ? null : patch.flagged ? 1 : 0, patch.note ?? null, id);
    return Number(result.changes) > 0;
  },

  systemPrompt(db: Db, hash: string): string | null {
    const row = db.prepare('SELECT content FROM agent_system_prompts WHERE hash = ?').get(hash) as
      { content: string } | undefined;
    return row?.content ?? null;
  },

  /**
   * One song in the order things happened. Null for a song the agent never worked on: logging must not open up
   * songs that were never sent to it.
   */
  songHistory(db: Db, songId: number): AgentSongHistoryDto | null {
    const song = db.prepare('SELECT id, title, brief FROM songs WHERE id = ?').get(songId) as
      { id: number; title: string; brief: string | null } | undefined;
    if (!song) return null;
    const rows = db
      .prepare(`${RUN_SELECT} WHERE r.song_id = ? ORDER BY r.id LIMIT ?`)
      .all(songId, MAX_EXPORTED_RUNS) as unknown as RunRow[];
    if (!rows.length) return null;
    const runs = loadRuns(db, rows);
    const versions = db
      .prepare(
        `SELECT id, number, parent_version_id, author_kind, message, code, created_at FROM song_versions
         WHERE song_id = ? ORDER BY id`,
      )
      .all(songId) as unknown as {
      id: number;
      number: number;
      parent_version_id: number | null;
      author_kind: AgentHistoryVersion['authorKind'];
      message: string | null;
      code: string;
      created_at: number;
    }[];

    // Versions and runs have separate clocks of ids, so time decides. On a tie the request came first.
    const timed = [
      ...runs.map((run, i) => ({ ms: Date.parse(run.at), order: 0, i, run })),
      ...versions.map((version, i) => ({ ms: version.created_at, order: 1, i, version })),
    ].sort((a, b) => a.ms - b.ms || a.order - b.order || a.i - b.i);

    let savedCode: string | null = null;
    const events: AgentHistoryEventDto[] = timed.map((t) => {
      const at = iso(t.ms);
      if ('run' in t && t.run) {
        const edited =
          EDITOR_PURPOSES.has(t.run.purpose) && savedCode !== null && t.run.inputCode !== savedCode;
        return { kind: 'run', at, run: t.run, editedSinceLastVersion: edited };
      }
      const v = (t as { version: (typeof versions)[number] }).version;
      savedCode = v.code;
      return {
        kind: 'version',
        at,
        version: {
          id: v.id,
          number: v.number,
          parentVersionId: v.parent_version_id,
          authorKind: v.author_kind,
          message: v.message,
          code: v.code,
        },
      };
    });
    return {
      song: {
        id: song.id,
        title: song.title,
        brief: song.brief ? (JSON.parse(song.brief) as Record<string, string>) : null,
      },
      events,
    };
  },

  exportSong(db: Db, songId: number): AgentRunsExport | null {
    const history = agentRuns.songHistory(db, songId);
    return history ? exportFile(db, 'song', history.song, history.events) : null;
  },

  exportMarked(db: Db): AgentRunsExport {
    const rows = db
      .prepare(`${RUN_SELECT} WHERE r.flagged = 1 ORDER BY r.id LIMIT ?`)
      .all(MAX_EXPORTED_RUNS) as unknown as RunRow[];
    const events: AgentHistoryEventDto[] = loadRuns(db, rows).map((run) => ({
      kind: 'run',
      at: run.at,
      run,
      editedSinceLastVersion: false,
    }));
    return exportFile(db, 'marked', null, events);
  },

  /** Keeps what the admin marked. Returns how many runs went. */
  deleteOld(db: Db, now = Date.now()): number {
    const result = db
      .prepare('DELETE FROM agent_runs WHERE flagged = 0 AND created_at < ?')
      .run(now - AGENT_RUN_RETENTION_DAYS * DAY_MS);
    db.exec(`DELETE FROM agent_system_prompts WHERE hash NOT IN
      (SELECT system_prompt_hash FROM agent_run_attempts WHERE system_prompt_hash IS NOT NULL)`);
    return Number(result.changes);
  },
};
