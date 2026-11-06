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
  {
    id: 5,
    name: 'agent',
    sql: `
      CREATE TABLE agent_calls (
        id INTEGER PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        song_id INTEGER REFERENCES songs(id) ON DELETE SET NULL,
        purpose TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX agent_calls_user_at ON agent_calls(user_id, created_at);
      CREATE INDEX agent_calls_at ON agent_calls(created_at);

      CREATE TABLE agent_proposals (
        id INTEGER PRIMARY KEY,
        song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        base_version_id INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
        instruction TEXT NOT NULL,
        track TEXT,
        tier TEXT NOT NULL,
        summary TEXT NOT NULL,
        base_code TEXT NOT NULL,
        code TEXT NOT NULL,
        brief TEXT,
        repairs INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        cost_usd REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX agent_proposals_song ON agent_proposals(song_id, id);
    `,
  },
  {
    id: 6,
    name: 'agent chat',
    sql: `
      CREATE TABLE agent_chat_messages (
        id INTEGER PRIMARY KEY,
        song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        proposal_id INTEGER REFERENCES agent_proposals(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX agent_chat_song ON agent_chat_messages(song_id, user_id, id);
    `,
  },
  {
    id: 7,
    name: 'song explanations',
    sql: `
      CREATE TABLE song_explanations (
        id INTEGER PRIMARY KEY,
        song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
        version_id INTEGER NOT NULL REFERENCES song_versions(id) ON DELETE CASCADE,
        author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        level TEXT NOT NULL,
        note TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX song_explanations_song ON song_explanations(song_id, id);
    `,
  },
  {
    id: 8,
    name: 'agent run logs',
    // A run is one request to the agent; each model call in it is an attempt. Decisions on proposals are
    // read from agent_proposals. The text of a model's thinking is never stored, only its token count.
    sql: `
      CREATE TABLE agent_system_prompts (
        hash TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE agent_runs (
        id INTEGER PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        song_id INTEGER REFERENCES songs(id) ON DELETE CASCADE,
        proposal_id INTEGER REFERENCES agent_proposals(id) ON DELETE SET NULL,
        purpose TEXT NOT NULL,
        tier TEXT NOT NULL,
        request TEXT NOT NULL,
        input_code TEXT,
        output_code TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'cancelled')),
        error TEXT,
        flagged INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX agent_runs_at ON agent_runs(created_at);
      CREATE INDEX agent_runs_song ON agent_runs(song_id, id);
      CREATE INDEX agent_runs_flagged ON agent_runs(flagged, id);

      CREATE TABLE agent_run_attempts (
        id INTEGER PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        model TEXT NOT NULL,
        system_prompt_hash TEXT REFERENCES agent_system_prompts(hash),
        messages TEXT NOT NULL,
        answer TEXT,
        rejection TEXT,
        error TEXT,
        finish_reason TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        reasoning_tokens INTEGER,
        cached_tokens INTEGER,
        cost_usd REAL NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (run_id, number)
      );
    `,
  },
  {
    id: 9,
    name: 'model chosen for a proposal',
    // A repair must go to the same model as the proposal, or a comparison of models would mean nothing.
    sql: `ALTER TABLE agent_proposals ADD COLUMN requested_model TEXT;`,
  },
];
