import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations';

export type Db = DatabaseSync;

/** Opens (or creates) the SQLite database and applies pending migrations. Use ':memory:' in tests. */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const applied = new Set(
    db
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((r) => Number(r.id)),
  );
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(m.id, m.name);
    });
  }
}

/** Runs fn inside a transaction; rolls back if it throws. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
