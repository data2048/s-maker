// Database access for songs and their versions. Every version is immutable: saving creates a new one.
import type {
  SongDto,
  SongSummaryDto,
  UserRefDto,
  VersionDto,
  VersionSummaryDto,
  Visibility,
} from '@s-maker/shared';
import type { Db } from '../db';
import { transaction } from '../db';
import type { UserRow } from '../auth/store';

const iso = (ms: number) => new Date(ms).toISOString();

export interface SongRow {
  id: number;
  owner_id: number;
  title: string;
  visibility: Visibility;
  forked_from_song_id: number | null;
  forked_from_version_id: number | null;
  current_version_id: number;
  created_at: number;
  updated_at: number;
}

interface SongListRow extends SongRow {
  owner_username: string;
  owner_display_name: string;
  version_count: number;
  forked_title: string | null;
  forked_visibility: Visibility | null;
  forked_owner_id: number | null;
}

interface VersionRow {
  id: number;
  song_id: number;
  number: number;
  parent_version_id: number | null;
  author_id: number | null;
  author_kind: 'user' | 'agent';
  message: string | null;
  code: string;
  created_at: number;
  author_username: string | null;
  author_display_name: string | null;
}

const SONG_SELECT = `
  SELECT s.*, u.username AS owner_username, u.display_name AS owner_display_name,
         (SELECT COUNT(*) FROM song_versions v WHERE v.song_id = s.id) AS version_count,
         f.title AS forked_title, f.visibility AS forked_visibility, f.owner_id AS forked_owner_id
  FROM songs s
  JOIN users u ON u.id = s.owner_id
  LEFT JOIN songs f ON f.id = s.forked_from_song_id`;

const VERSION_SELECT = `
  SELECT v.*, u.username AS author_username, u.display_name AS author_display_name
  FROM song_versions v LEFT JOIN users u ON u.id = v.author_id`;

function toSummary(r: SongListRow, viewer: UserRow): SongSummaryDto {
  // A private source song stays private: show only that it was forked, not its title.
  const sourceVisible = r.forked_visibility === 'group' || r.forked_owner_id === viewer.id;
  const forkedFrom =
    r.forked_from_song_id == null
      ? null
      : { songId: r.forked_from_song_id, title: sourceVisible ? r.forked_title : null };
  return {
    id: r.id,
    title: r.title,
    owner: { id: r.owner_id, username: r.owner_username, displayName: r.owner_display_name },
    visibility: r.visibility,
    versionCount: Number(r.version_count),
    forkedFrom,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toVersionSummary(v: VersionRow): VersionSummaryDto {
  const author: UserRefDto | null =
    v.author_id == null
      ? null
      : { id: v.author_id, username: v.author_username ?? '?', displayName: v.author_display_name ?? '?' };
  return {
    id: v.id,
    number: v.number,
    author,
    authorKind: v.author_kind,
    message: v.message,
    createdAt: iso(v.created_at),
  };
}

const toVersion = (v: VersionRow): VersionDto => ({ ...toVersionSummary(v), code: v.code });

/** Visibility rule used everywhere: owners see their songs, everyone in the group sees 'group' songs. */
export function canView(song: SongRow, user: UserRow): boolean {
  return song.owner_id === user.id || song.visibility === 'group';
}

export function canEdit(song: SongRow, user: UserRow): boolean {
  return song.owner_id === user.id;
}

export const songs = {
  byId(db: Db, id: number): SongRow | undefined {
    return db.prepare('SELECT * FROM songs WHERE id = ?').get(id) as SongRow | undefined;
  },

  listMine(db: Db, user: UserRow): SongSummaryDto[] {
    const rows = db
      .prepare(`${SONG_SELECT} WHERE s.owner_id = ? ORDER BY s.updated_at DESC LIMIT 500`)
      .all(user.id) as unknown as SongListRow[];
    return rows.map((r) => toSummary(r, user));
  },

  listGroup(db: Db, user: UserRow): SongSummaryDto[] {
    const rows = db
      .prepare(
        `${SONG_SELECT} WHERE s.owner_id != ? AND s.visibility = 'group' ORDER BY s.updated_at DESC LIMIT 500`,
      )
      .all(user.id) as unknown as SongListRow[];
    return rows.map((r) => toSummary(r, user));
  },

  dto(db: Db, song: SongRow, viewer: UserRow): SongDto {
    const row = db.prepare(`${SONG_SELECT} WHERE s.id = ?`).get(song.id) as unknown as SongListRow;
    const current = versions.byId(db, song.current_version_id)!;
    const summary = toSummary(row, viewer);
    return { ...summary, currentVersion: toVersion(current), canEdit: canEdit(song, viewer) };
  },

  create(
    db: Db,
    s: {
      ownerId: number;
      title: string;
      visibility: Visibility;
      code: string;
      message?: string;
      forkedFromSongId?: number;
      forkedFromVersionId?: number;
    },
  ): SongRow {
    return transaction(db, () => {
      const now = Date.now();
      const r = db
        .prepare(
          `INSERT INTO songs (owner_id, title, visibility, forked_from_song_id, forked_from_version_id,
                              current_version_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          s.ownerId,
          s.title,
          s.visibility,
          s.forkedFromSongId ?? null,
          s.forkedFromVersionId ?? null,
          now,
          now,
        );
      const songId = Number(r.lastInsertRowid);
      insertVersion(db, songId, {
        number: 1,
        parentVersionId: null,
        authorId: s.ownerId,
        authorKind: 'user',
        message: s.message ?? 'Created',
        code: s.code,
      });
      return songs.byId(db, songId)!;
    });
  },

  update(db: Db, id: number, patch: { title?: string; visibility?: Visibility }): void {
    const s = songs.byId(db, id);
    if (!s) return;
    db.prepare('UPDATE songs SET title = ?, visibility = ?, updated_at = ? WHERE id = ?').run(
      patch.title ?? s.title,
      patch.visibility ?? s.visibility,
      Date.now(),
      id,
    );
  },

  delete(db: Db, id: number): void {
    db.prepare('DELETE FROM songs WHERE id = ?').run(id);
  },
};

function insertVersion(
  db: Db,
  songId: number,
  v: {
    number: number;
    parentVersionId: number | null;
    authorId: number | null;
    authorKind: 'user' | 'agent';
    message: string | null;
    code: string;
  },
): number {
  const now = Date.now();
  const r = db
    .prepare(
      `INSERT INTO song_versions (song_id, number, parent_version_id, author_id, author_kind, message, code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(songId, v.number, v.parentVersionId, v.authorId, v.authorKind, v.message, v.code, now);
  const id = Number(r.lastInsertRowid);
  db.prepare('UPDATE songs SET current_version_id = ?, updated_at = ? WHERE id = ?').run(id, now, songId);
  return id;
}

export const versions = {
  byId(db: Db, id: number): VersionRow | undefined {
    return db.prepare(`${VERSION_SELECT} WHERE v.id = ?`).get(id) as VersionRow | undefined;
  },

  get(db: Db, songId: number, versionId: number): VersionDto | undefined {
    const v = versions.byId(db, versionId);
    return v && v.song_id === songId ? toVersion(v) : undefined;
  },

  list(db: Db, songId: number): VersionSummaryDto[] {
    const rows = db
      .prepare(`${VERSION_SELECT} WHERE v.song_id = ? ORDER BY v.number DESC LIMIT 1000`)
      .all(songId) as unknown as VersionRow[];
    return rows.map(toVersionSummary);
  },

  /**
   * Adds a version on top of the current one. Returns null if the song moved on since baseVersionId
   * (someone saved in another tab): the caller answers 409 instead of silently overwriting.
   */
  add(
    db: Db,
    songId: number,
    v: {
      baseVersionId: number;
      authorId: number;
      authorKind: 'user' | 'agent';
      message: string | null;
      code: string;
    },
  ): VersionDto | null {
    return transaction(db, () => {
      const song = songs.byId(db, songId);
      if (!song || song.current_version_id !== v.baseVersionId) return null;
      const max = Number(
        db.prepare('SELECT MAX(number) AS n FROM song_versions WHERE song_id = ?').get(songId)!.n ?? 0,
      );
      const id = insertVersion(db, songId, {
        number: max + 1,
        parentVersionId: v.baseVersionId,
        authorId: v.authorId,
        authorKind: v.authorKind,
        message: v.message,
        code: v.code,
      });
      return toVersion(versions.byId(db, id)!);
    });
  },
};
