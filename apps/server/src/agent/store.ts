// Agent data: call log with costs, settings and proposals.
import type {
  AgentCallDto,
  AgentProposalDto,
  AgentSettings,
  AgentUsageDto,
  MusicBrief,
} from '@s-maker/shared';
import type { Config } from '../config';
import type { Db } from '../db';

const WEEK_MS = 7 * 24 * 3600 * 1000;
const SETTINGS_KEY = 'agent.settings';

export const agentSettings = {
  get(db: Db, config: Config): AgentSettings {
    const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(SETTINGS_KEY) as
      { value: string } | undefined;
    return { ...config.agentDefaults, ...(row ? (JSON.parse(row.value) as Partial<AgentSettings>) : {}) };
  },
  set(db: Db, settings: AgentSettings): void {
    db.prepare(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(SETTINGS_KEY, JSON.stringify(settings));
  },
};

export const agentCalls = {
  log(
    db: Db,
    c: {
      userId: number;
      songId: number | null;
      purpose: string;
      model: string;
      promptTokens?: number;
      completionTokens?: number;
      costUsd?: number;
      status: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO agent_calls (user_id, song_id, purpose, model, prompt_tokens, completion_tokens,
                                cost_usd, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      c.userId,
      c.songId,
      c.purpose,
      c.model,
      c.promptTokens ?? 0,
      c.completionTokens ?? 0,
      c.costUsd ?? 0,
      c.status,
      Date.now(),
    );
  },

  spentByUser(db: Db, userId: number): number {
    const r = db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM agent_calls WHERE user_id = ? AND created_at > ?')
      .get(userId, Date.now() - WEEK_MS) as { s: number };
    return r.s;
  },

  spentTotal(db: Db): number {
    const r = db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM agent_calls WHERE created_at > ?')
      .get(Date.now() - WEEK_MS) as { s: number };
    return r.s;
  },

  spending(db: Db): { username: string; spentUsd: number; calls: number }[] {
    return db
      .prepare(
        `SELECT u.username AS username, COALESCE(SUM(c.cost_usd), 0) AS spentUsd, COUNT(*) AS calls
         FROM agent_calls c JOIN users u ON u.id = c.user_id
         WHERE c.created_at > ? GROUP BY u.id ORDER BY spentUsd DESC`,
      )
      .all(Date.now() - WEEK_MS) as unknown as { username: string; spentUsd: number; calls: number }[];
  },

  recent(db: Db, limit = 50): AgentCallDto[] {
    const rows = db
      .prepare(
        `SELECT c.*, u.username AS username FROM agent_calls c LEFT JOIN users u ON u.id = c.user_id
         ORDER BY c.id DESC LIMIT ?`,
      )
      .all(limit) as unknown as {
      id: number;
      created_at: number;
      username: string | null;
      song_id: number | null;
      purpose: string;
      model: string;
      prompt_tokens: number;
      completion_tokens: number;
      cost_usd: number;
      status: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: new Date(r.created_at).toISOString(),
      username: r.username,
      songId: r.song_id,
      purpose: r.purpose,
      model: r.model,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      costUsd: r.cost_usd,
      status: r.status,
    }));
  },

  usage(db: Db, userId: number, settings: AgentSettings, enabled: boolean): AgentUsageDto {
    return {
      enabled,
      spentUsd: agentCalls.spentByUser(db, userId),
      limitUsd: settings.userWeeklyLimitUsd,
      groupSpentUsd: agentCalls.spentTotal(db),
      groupLimitUsd: settings.globalWeeklyLimitUsd,
    };
  },
};

interface ProposalRow {
  id: number;
  song_id: number;
  user_id: number;
  base_version_id: number;
  status: AgentProposalDto['status'];
  instruction: string;
  track: string | null;
  tier: string;
  summary: string;
  base_code: string;
  code: string;
  brief: string | null;
  repairs: number;
  model: string;
  cost_usd: number;
}

export type { ProposalRow };

export function proposalDto(r: ProposalRow): AgentProposalDto {
  return {
    id: r.id,
    songId: r.song_id,
    status: r.status,
    instruction: r.instruction,
    summary: r.summary,
    baseCode: r.base_code,
    code: r.code,
    brief: r.brief ? (JSON.parse(r.brief) as MusicBrief) : null,
    repairs: r.repairs,
    model: r.model,
    costUsd: r.cost_usd,
  };
}

export const proposals = {
  create(
    db: Db,
    p: {
      songId: number;
      userId: number;
      baseVersionId: number;
      instruction: string;
      track: string | null;
      tier: string;
      summary: string;
      baseCode: string;
      code: string;
      brief: MusicBrief | null;
      model: string;
      costUsd: number;
    },
  ): ProposalRow {
    const r = db
      .prepare(
        `INSERT INTO agent_proposals (song_id, user_id, base_version_id, status, instruction, track, tier,
                                      summary, base_code, code, brief, model, cost_usd, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.songId,
        p.userId,
        p.baseVersionId,
        p.instruction,
        p.track,
        p.tier,
        p.summary,
        p.baseCode,
        p.code,
        p.brief ? JSON.stringify(p.brief) : null,
        p.model,
        p.costUsd,
        Date.now(),
      );
    return proposals.get(db, p.songId, p.userId, Number(r.lastInsertRowid))!;
  },

  /** Only the user who asked can see or use a proposal. */
  get(db: Db, songId: number, userId: number, id: number): ProposalRow | undefined {
    return db
      .prepare('SELECT * FROM agent_proposals WHERE id = ? AND song_id = ? AND user_id = ?')
      .get(id, songId, userId) as ProposalRow | undefined;
  },

  setStatus(db: Db, id: number, status: 'accepted' | 'rejected'): void {
    db.prepare('UPDATE agent_proposals SET status = ? WHERE id = ?').run(status, id);
  },

  updateAfterRepair(
    db: Db,
    id: number,
    p: { code: string; summary: string; brief: MusicBrief | null; model: string; addCost: number },
  ): void {
    db.prepare(
      `UPDATE agent_proposals SET code = ?, summary = ?, brief = ?, model = ?,
         cost_usd = cost_usd + ?, repairs = repairs + 1 WHERE id = ?`,
    ).run(p.code, p.summary, p.brief ? JSON.stringify(p.brief) : null, p.model, p.addCost, id);
  },
};
