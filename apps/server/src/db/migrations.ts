// Ordered list of schema migrations. Never edit a migration that has shipped: add a new one.
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'app_meta',
    sql: `CREATE TABLE app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  },
  {
    id: 2,
    name: 'auth',
    // Timestamps are unix epoch milliseconds (INTEGER).
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        id_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX sessions_user ON sessions(user_id);

      CREATE TABLE invites (
        id INTEGER PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        username TEXT,
        note TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        revoked_at INTEGER
      );

      CREATE TABLE login_failures (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE,
        ip TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX login_failures_username_at ON login_failures(username, at);

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        ip TEXT,
        details TEXT
      );
      CREATE INDEX audit_log_at ON audit_log(at);
    `,
  },
  {
    id: 3,
    name: 'songs',
    sql: `
      CREATE TABLE songs (
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('group', 'private')),
        forked_from_song_id INTEGER REFERENCES songs(id) ON DELETE SET NULL,
        forked_from_version_id INTEGER REFERENCES song_versions(id) ON DELETE SET NULL,
        brief TEXT,
        current_version_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX songs_owner ON songs(owner_id);
      CREATE INDEX songs_updated ON songs(updated_at);

      CREATE TABLE song_versions (
        id INTEGER PRIMARY KEY,
        song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        parent_version_id INTEGER REFERENCES song_versions(id) ON DELETE SET NULL,
        author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent')),
        message TEXT,
        code TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (song_id, number)
      );
    `,
  },
  {
    id: 4,
    name: 'midi uploads',
    // The file itself is stored in the database: no file paths built from user input, and the
    // uploads are part of the regular volume backup.
    sql: `
      CREATE TABLE midi_uploads (
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        data BLOB NOT NULL,
        analysis TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX midi_uploads_owner ON midi_uploads(owner_id, created_at);
      ALTER TABLE songs ADD COLUMN midi_upload_id INTEGER REFERENCES midi_uploads(id) ON DELETE SET NULL;
    `,
  },
];
