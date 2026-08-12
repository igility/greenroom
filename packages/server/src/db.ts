import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE builds (
    id TEXT PRIMARY KEY,
    manifest_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    git_sha TEXT,
    story_count INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE stories (
    story_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    import_path TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'in_review',
    anchor_build_id TEXT REFERENCES builds(id),
    last_seen_build_id TEXT NOT NULL REFERENCES builds(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL REFERENCES stories(story_id),
    build_id TEXT NOT NULL REFERENCES builds(id),
    state TEXT NOT NULL DEFAULT 'open',
    selector TEXT,
    x REAL,
    y REAL,
    viewport_w INTEGER,
    viewport_h INTEGER,
    args_json TEXT,
    screenshot_attachment_id TEXT,
    created_by_kind TEXT NOT NULL,
    created_by_id TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    author_kind TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE status_events (
    id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    principal_kind TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    principal_name TEXT NOT NULL,
    approval_mode TEXT,
    delegation_id TEXT,
    build_id TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE fingerprints (
    story_id TEXT NOT NULL,
    build_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (story_id, build_id)
  );
  CREATE TABLE reviewers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'approver',
    created_at TEXT NOT NULL
  );
  CREATE TABLE magic_links (
    token TEXT PRIMARY KEY,
    reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
    created_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE delegations (
    id TEXT PRIMARY KEY,
    authorization_note TEXT NOT NULL,
    enabled_by_kind TEXT NOT NULL,
    enabled_by_id TEXT NOT NULL,
    enabled_by_name TEXT NOT NULL,
    enabled_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_threads_story ON threads(story_id);
  CREATE INDEX idx_threads_state ON threads(state);
  CREATE INDEX idx_messages_thread ON messages(thread_id);
  CREATE INDEX idx_events_story ON status_events(story_id);
  `,
];

export function openDb(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'greenroom.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** In-memory database for tests. */
export function openMemoryDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
