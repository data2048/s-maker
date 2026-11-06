import { createHash } from 'node:crypto';
import { classifyMidi, type MidiAnalysis, type MidiUploadDto } from '@s-maker/shared';
import type { Db } from '../db';

/** Uploads kept per user; older ones are removed automatically (songs made from them stay). */
export const MAX_UPLOADS_PER_USER = 50;

interface UploadRow {
  id: number;
  owner_id: number;
  file_name: string;
  size: number;
  sha256: string;
  analysis: string;
  created_at: number;
}

const COLUMNS = 'id, owner_id, file_name, size, sha256, analysis, created_at';

/** Uploads stored before classification existed get it from their saved analysis. */
function withClassification(a: MidiAnalysis): MidiAnalysis {
  return a.classification ? a : { ...a, classification: classifyMidi(a) };
}

function toDto(r: UploadRow): MidiUploadDto {
  return {
    id: r.id,
    fileName: r.file_name,
    size: r.size,
    createdAt: new Date(r.created_at).toISOString(),
    analysis: withClassification(JSON.parse(r.analysis) as MidiAnalysis),
  };
}

export const midiUploads = {
  /** Stores an upload; uploading the same file again returns the existing one. */
  add(db: Db, ownerId: number, fileName: string, bytes: Uint8Array, analysis: MidiAnalysis): MidiUploadDto {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = db
      .prepare(`SELECT ${COLUMNS} FROM midi_uploads WHERE owner_id = ? AND sha256 = ?`)
      .get(ownerId, sha256) as UploadRow | undefined;
    if (existing) return toDto(existing);

    const r = db
      .prepare(
        `INSERT INTO midi_uploads (owner_id, file_name, size, sha256, data, analysis, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ownerId, fileName, bytes.length, sha256, bytes, JSON.stringify(analysis), Date.now());
    db.prepare(
      `DELETE FROM midi_uploads WHERE owner_id = ? AND id NOT IN
         (SELECT id FROM midi_uploads WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
    ).run(ownerId, ownerId, MAX_UPLOADS_PER_USER);
    return midiUploads.get(db, ownerId, Number(r.lastInsertRowid))!;
  },

  /** Only the owner can see an upload (others get undefined → 404). */
  get(db: Db, ownerId: number, id: number): MidiUploadDto | undefined {
    const r = db
      .prepare(`SELECT ${COLUMNS} FROM midi_uploads WHERE id = ? AND owner_id = ?`)
      .get(id, ownerId) as UploadRow | undefined;
    return r && toDto(r);
  },

  data(db: Db, ownerId: number, id: number): Uint8Array | undefined {
    const r = db.prepare('SELECT data FROM midi_uploads WHERE id = ? AND owner_id = ?').get(id, ownerId) as
      { data: Uint8Array } | undefined;
    return r?.data;
  },

  list(db: Db, ownerId: number): MidiUploadDto[] {
    const rows = db
      .prepare(`SELECT ${COLUMNS} FROM midi_uploads WHERE owner_id = ? ORDER BY created_at DESC, id DESC`)
      .all(ownerId) as unknown as UploadRow[];
    return rows.map(toDto);
  },

  delete(db: Db, ownerId: number, id: number): boolean {
    return db.prepare('DELETE FROM midi_uploads WHERE id = ? AND owner_id = ?').run(id, ownerId).changes > 0;
  },
};
