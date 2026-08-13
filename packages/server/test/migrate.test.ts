import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, SCHEMA_VERSION } from '../src/db.js';

/**
 * The v2 migration rebuilds `fingerprints` to add `region_key` to its primary key,
 * which SQLite cannot do in place. A fresh database proves nothing about that path —
 * these tests upgrade a populated v1 database and check the data survived.
 */

let dir: string;

/** A v1 database with one build, one story, and one fingerprint. */
function seedV1(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'greenroom.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE builds (
      id TEXT PRIMARY KEY, manifest_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      git_sha TEXT, story_count INTEGER NOT NULL, storage_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE stories (
      story_id TEXT PRIMARY KEY, title TEXT NOT NULL, import_path TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'in_review', anchor_build_id TEXT REFERENCES builds(id),
      last_seen_build_id TEXT NOT NULL REFERENCES builds(id), created_at TEXT NOT NULL
    );
    CREATE TABLE reviewers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'approver', created_at TEXT NOT NULL
    );
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, story_id TEXT NOT NULL REFERENCES stories(story_id),
      build_id TEXT NOT NULL REFERENCES builds(id), state TEXT NOT NULL DEFAULT 'open',
      selector TEXT, x REAL, y REAL, viewport_w INTEGER, viewport_h INTEGER,
      args_json TEXT, screenshot_attachment_id TEXT, created_by_kind TEXT NOT NULL,
      created_by_id TEXT NOT NULL, created_by_name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
      author_kind TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE fingerprints (
      story_id TEXT NOT NULL, build_id TEXT NOT NULL, hash TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY (story_id, build_id)
    );
  `);
  db.prepare(
    `INSERT INTO builds (id, manifest_hash, label, git_sha, story_count, storage_path, created_at)
     VALUES ('b1', 'h1', 'first', NULL, 1, '/tmp/b1', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO stories (story_id, title, import_path, state, anchor_build_id, last_seen_build_id, created_at)
     VALUES ('components-button--primary', 'Button / Primary', './Button.stories.tsx', 'approved', 'b1', 'b1', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO fingerprints (story_id, build_id, hash, created_at)
     VALUES ('components-button--primary', 'b1', 'deadbeef', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO threads (id, story_id, build_id, state, created_by_kind, created_by_id, created_by_name, created_at)
     VALUES ('t1', 'components-button--primary', 'b1', 'open', 'reviewer', 'r1', 'Jordan', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO messages (id, thread_id, author_kind, author_id, author_name, kind, body, created_at)
     VALUES ('m1', 't1', 'reviewer', 'r1', 'Jordan', 'comment', 'Too cramped.', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.pragma('user_version = 1');
  db.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-migrate-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('v1 → current migration', () => {
  it('upgrades a populated v1 database and preserves fingerprint rows as root regions', () => {
    seedV1(dir);
    const db = openDb(dir);

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const fp = db
      .prepare('SELECT story_id, build_id, region_key, hash FROM fingerprints')
      .all() as { story_id: string; build_id: string; region_key: string; hash: string }[];
    expect(fp).toEqual([
      {
        story_id: 'components-button--primary',
        build_id: 'b1',
        region_key: '',
        hash: 'deadbeef',
      },
    ]);
    db.close();
  });

  it('keeps existing stories and defaults them to kind=story', () => {
    seedV1(dir);
    const db = openDb(dir);
    const row = db
      .prepare('SELECT kind, state, anchor_build_id FROM stories WHERE story_id = ?')
      .get('components-button--primary') as {
      kind: string;
      state: string;
      anchor_build_id: string;
    };
    // An existing approval must survive the migration untouched — a schema change is
    // not a reason to invalidate a sign-off the client already gave.
    expect(row).toEqual({ kind: 'story', state: 'approved', anchor_build_id: 'b1' });
    db.close();
  });

  it('accepts per-region fingerprints for the same story and build after upgrading', () => {
    seedV1(dir);
    const db = openDb(dir);
    db.prepare(
      `INSERT INTO fingerprints (story_id, build_id, region_key, hash, created_at)
       VALUES ('components-button--primary', 'b1', 'components-input--default', 'cafe', '2026-01-02T00:00:00.000Z')`,
    ).run();
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM fingerprints WHERE story_id = ? AND build_id = ?')
      .get('components-button--primary', 'b1') as { n: number };
    expect(n.n).toBe(2);
    db.close();
  });

  it('preserves threads and their messages across the rebuild, with a null seenOn', () => {
    seedV1(dir);
    const db = openDb(dir);
    const t = db
      .prepare('SELECT story_id, seen_on_story_id FROM threads WHERE id = ?')
      .get('t1') as { story_id: string; seen_on_story_id: string | null };
    // A pre-existing comment predates contact sheets: it was left on the story itself,
    // so it has no separate vantage point to record.
    expect(t).toEqual({ story_id: 'components-button--primary', seen_on_story_id: null });
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get('t1') as { n: number }).n,
    ).toBe(1);
    db.close();
  });

  it('is idempotent — reopening an already-migrated database is a no-op', () => {
    seedV1(dir);
    openDb(dir).close();
    const db = openDb(dir);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM fingerprints').get() as { n: number }).n,
    ).toBe(1);
    db.close();
  });
});
