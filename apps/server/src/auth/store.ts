// Database access for users, sessions, invites, login failures and the audit log.
// All SQL uses bound parameters (never string concatenation) to prevent injection.
import type { InviteDto, Role, UserDto, AuditEntryDto } from '@s-maker/shared';
import type { Db } from '../db';
import { hashToken, randomToken } from './crypto';

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());

// ---------- users ----------

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  active: number;
  created_at: number;
  updated_at: number;
}

export function toUserDto(u: UserRow): UserDto {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    active: u.active === 1,
    createdAt: iso(u.created_at)!,
  };
}

export const users = {
  count(db: Db): number {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n);
  },
  byId(db: Db, id: number): UserRow | undefined {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  },
  byUsername(db: Db, username: string): UserRow | undefined {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  },
  list(db: Db): UserRow[] {
    return db.prepare('SELECT * FROM users ORDER BY created_at').all() as unknown as UserRow[];
  },
  create(db: Db, u: { username: string; displayName: string; passwordHash: string; role: Role }): UserRow {
    const now = Date.now();
    const r = db
      .prepare(
        `INSERT INTO users (username, display_name, password_hash, role, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(u.username, u.displayName, u.passwordHash, u.role, now, now);
    return users.byId(db, Number(r.lastInsertRowid))!;
  },
  update(
    db: Db,
    id: number,
    patch: { displayName?: string; passwordHash?: string; role?: Role; active?: boolean },
  ): void {
    const u = users.byId(db, id);
    if (!u) return;
    db.prepare(
      `UPDATE users SET display_name = ?, password_hash = ?, role = ?, active = ?, updated_at = ? WHERE id = ?`,
    ).run(
      patch.displayName ?? u.display_name,
      patch.passwordHash ?? u.password_hash,
      patch.role ?? u.role,
      patch.active === undefined ? u.active : patch.active ? 1 : 0,
      Date.now(),
      id,
    );
  },
  activeAdminCount(db: Db): number {
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`).get()!.n);
  },
};

// ---------- sessions ----------

export const SESSION_ABSOLUTE_MS = 30 * 24 * 3600 * 1000; // log in again at least every 30 days
export const SESSION_IDLE_MS = 7 * 24 * 3600 * 1000; // or after a week without activity
const TOUCH_EVERY_MS = 5 * 60 * 1000;

export interface SessionRow {
  id_hash: string;
  user_id: number;
  csrf_token: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

export const sessions = {
  create(db: Db, userId: number, meta: { ip?: string; userAgent?: string }) {
    const token = randomToken();
    const csrfToken = randomToken();
    const now = Date.now();
    db.prepare(
      `INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hashToken(token),
      userId,
      csrfToken,
      now,
      now,
      now + SESSION_ABSOLUTE_MS,
      meta.ip ?? null,
      meta.userAgent?.slice(0, 300) ?? null,
    );
    return { token, csrfToken };
  },

  /** Returns the session and its user if the token is valid, the session not expired and the user active. */
  resolve(db: Db, token: string): { session: SessionRow; user: UserRow } | undefined {
    const idHash = hashToken(token);
    const session = db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as
      SessionRow | undefined;
    if (!session) return undefined;
    const now = Date.now();
    if (session.expires_at <= now || session.last_seen_at + SESSION_IDLE_MS <= now) {
      db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
      return undefined;
    }
    const user = users.byId(db, session.user_id);
    if (!user || user.active !== 1) return undefined;
    if (now - session.last_seen_at > TOUCH_EVERY_MS) {
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, idHash);
    }
    return { session, user };
  },

  deleteByHash(db: Db, idHash: string): void {
    db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  },
  deleteForUser(db: Db, userId: number, exceptHash?: string): void {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(userId, exceptHash ?? '');
  },
  deleteExpired(db: Db): void {
    const now = Date.now();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(
      now,
      now - SESSION_IDLE_MS,
    );
  },
};

// ---------- invites ----------

interface InviteRow {
  id: number;
  token_hash: string;
  role: Role;
  username: string | null;
  note: string | null;
  created_by: number | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: number | null;
  revoked_at: number | null;
  created_by_name?: string | null;
  used_by_name?: string | null;
}

function inviteStatus(i: InviteRow, now = Date.now()): InviteDto['status'] {
  if (i.used_at) return 'used';
  if (i.revoked_at) return 'revoked';
  if (i.expires_at <= now) return 'expired';
  return 'pending';
}

export const invites = {
  create(
    db: Db,
    i: { role: Role; username?: string; note?: string; createdBy?: number; expiresInHours: number },
  ) {
    const token = randomToken();
    const now = Date.now();
    const r = db
      .prepare(
        `INSERT INTO invites (token_hash, role, username, note, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashToken(token),
        i.role,
        i.username ?? null,
        i.note ?? null,
        i.createdBy ?? null,
        now,
        now + i.expiresInHours * 3600 * 1000,
      );
    return { token, id: Number(r.lastInsertRowid) };
  },

  /** A pending (unused, unrevoked, unexpired) invite for this token. */
  findPending(db: Db, token: string): InviteRow | undefined {
    const row = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(hashToken(token)) as
      InviteRow | undefined;
    return row && inviteStatus(row) === 'pending' ? row : undefined;
  },

  /** Marks the invite used; returns false if someone used it in the meantime. */
  markUsed(db: Db, id: number, userId: number): boolean {
    const r = db
      .prepare(
        `UPDATE invites SET used_at = ?, used_by = ?
         WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(Date.now(), userId, id, Date.now());
    return Number(r.changes) === 1;
  },

  revoke(db: Db, id: number): boolean {
    const r = db
      .prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL')
      .run(Date.now(), id);
    return Number(r.changes) === 1;
  },

  /** Revokes all pending bootstrap (no creator) invites; used before printing a new setup link. */
  revokeBootstrap(db: Db): void {
    db.prepare(
      'UPDATE invites SET revoked_at = ? WHERE created_by IS NULL AND used_at IS NULL AND revoked_at IS NULL',
    ).run(Date.now());
  },

  byId(db: Db, id: number): InviteDto | undefined {
    return invites.list(db).find((i) => i.id === id);
  },

  list(db: Db): InviteDto[] {
    const rows = db
      .prepare(
        `SELECT i.*, c.username AS created_by_name, u.username AS used_by_name
         FROM invites i
         LEFT JOIN users c ON c.id = i.created_by
         LEFT JOIN users u ON u.id = i.used_by
         ORDER BY i.created_at DESC
         LIMIT 200`,
      )
      .all() as unknown as InviteRow[];
    const now = Date.now();
    return rows.map((i) => ({
      id: i.id,
      role: i.role,
      username: i.username,
      note: i.note,
      createdBy: i.created_by_name ?? null,
      createdAt: iso(i.created_at)!,
      expiresAt: iso(i.expires_at)!,
      usedAt: iso(i.used_at),
      usedBy: i.used_by_name ?? null,
      status: inviteStatus(i, now),
    }));
  },
};

// ---------- login failures (account lockout) ----------

export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MAX_FAILURES = 5;

export const loginFailures = {
  record(db: Db, username: string, ip: string | undefined): void {
    db.prepare('INSERT INTO login_failures (username, ip, at) VALUES (?, ?, ?)').run(
      username,
      ip ?? null,
      Date.now(),
    );
  },
  recentCount(db: Db, username: string): number {
    return Number(
      db
        .prepare('SELECT COUNT(*) AS n FROM login_failures WHERE username = ? AND at > ?')
        .get(username, Date.now() - LOCKOUT_WINDOW_MS)!.n,
    );
  },
  clear(db: Db, username: string): void {
    db.prepare('DELETE FROM login_failures WHERE username = ?').run(username);
  },
  deleteOld(db: Db): void {
    db.prepare('DELETE FROM login_failures WHERE at <= ?').run(Date.now() - LOCKOUT_WINDOW_MS);
  },
};

// ---------- audit log ----------

export const audit = {
  log(
    db: Db,
    action: string,
    e: { userId?: number | null; ip?: string | null; details?: Record<string, unknown> } = {},
  ): void {
    db.prepare('INSERT INTO audit_log (at, user_id, action, ip, details) VALUES (?, ?, ?, ?, ?)').run(
      Date.now(),
      e.userId ?? null,
      action,
      e.ip ?? null,
      e.details ? JSON.stringify(e.details) : null,
    );
  },
  list(db: Db, limit: number): AuditEntryDto[] {
    const rows = db
      .prepare(
        `SELECT a.id, a.at, a.action, a.ip, a.details, u.username AS actor
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.id DESC LIMIT ?`,
      )
      .all(limit) as unknown as {
      id: number;
      at: number;
      action: string;
      ip: string | null;
      details: string | null;
      actor: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: iso(r.at)!,
      action: r.action,
      actor: r.actor,
      ip: r.ip,
      details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null,
    }));
  },
};
