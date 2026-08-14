import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

/**
 * A migration is SQL, or a function when the step has to read what is already stored in
 * order to decide what to write.
 *
 * SQL alone was enough while every change was additive. It stops being enough at the
 * first backfill: recovering each story's durable identity means reading
 * `builds.storage_path`, opening that build's own `index.json`, matching it against the
 * `stories` rows and writing the result back — a read, a computation and a write, with
 * no seam between them that `db.exec` can reach. A function step runs inside the same
 * transaction as a SQL one, so a step that mixes the two is still all-or-nothing.
 *
 * A function step must be **synchronous**. `void` here does not mean that to TypeScript —
 * an `async` step typechecks — so the runner rejects one at execution time instead. Read
 * files with the synchronous `fs` calls.
 */
export type Migration = string | ((db: DB) => void);

const MIGRATIONS: Migration[] = [
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

  // v2 — tile-level review: story kind, sheet membership, per-region fingerprints,
  // and per-reviewer progress.
  `
  -- A contact sheet is an ordinary index entry, so it gets a stories row whether or
  -- not we want one. Its state therefore cannot be "derived, never stored" — without
  -- an explicit kind it lands in the batch-approve set and in the agent's work queue,
  -- where approving it signs off a surface that reviews nothing and an agent edits the
  -- review instrument instead of the product.
  ALTER TABLE stories ADD COLUMN kind TEXT NOT NULL DEFAULT 'story';

  -- Which stories a sheet surveys. Provenance ("where was this comment left") is not
  -- this relation and cannot substitute for it: the rollup, the sheet's rail, the batch
  -- verb and the re-confirm tour all need membership. Recorded per build so a member
  -- that vanishes from the codebase is expressible rather than silently absent.
  -- member_story_id is intentionally not a foreign key, matching status_events.story_id.
  -- Validation happens in putRenderReport instead, which resolves every declared region
  -- against the stories present in that build and drops the ones that do not resolve —
  -- a stale tile id in host markup must be reported, never recorded as a real member.
  CREATE TABLE sheet_members (
    sheet_story_id TEXT NOT NULL REFERENCES stories(story_id),
    member_story_id TEXT NOT NULL,
    build_id TEXT NOT NULL REFERENCES builds(id),
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (sheet_story_id, member_story_id, build_id)
  );
  CREATE INDEX idx_sheet_members_sheet ON sheet_members(sheet_story_id, build_id);
  CREATE INDEX idx_sheet_members_member ON sheet_members(member_story_id, build_id);

  -- Which surfaces a given reviewer has actually looked at. Round-ness is a property
  -- of a person, not of a story: with several stakeholders on separate magic links,
  -- one finishing their pass must not drop another into a queue of work they have
  -- never seen. Also supplies the cheap non-committal "viewed" mark that sits between
  -- untouched and approved.
  CREATE TABLE reviewer_progress (
    reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
    story_id TEXT NOT NULL,
    build_id TEXT NOT NULL REFERENCES builds(id),
    seen_at TEXT NOT NULL,
    PRIMARY KEY (reviewer_id, story_id, build_id)
  );

  -- Fingerprints gain a region key. SQLite cannot alter a primary key in place, so the
  -- table is rebuilt; every existing row becomes a whole-story region (''), preserving
  -- the current re-confirm verdicts exactly.
  CREATE TABLE fingerprints_v2 (
    story_id TEXT NOT NULL,
    build_id TEXT NOT NULL,
    region_key TEXT NOT NULL DEFAULT '',
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (story_id, build_id, region_key)
  );
  INSERT INTO fingerprints_v2 (story_id, build_id, region_key, hash, created_at)
    SELECT story_id, build_id, '', hash, created_at FROM fingerprints;
  DROP TABLE fingerprints;
  ALTER TABLE fingerprints_v2 RENAME TO fingerprints;
  `,

  // v3 — where a comment was left, as distinct from what it is about.
  `
  -- A comment made on a contact sheet is ABOUT the component whose tile was clicked —
  -- that is where the fix happens and where approving it should clear it — but it was
  -- SAID while looking at the sheet. Attribution without provenance loses the reviewer's
  -- vantage point; provenance without attribution piles every comment onto a surface
  -- that contains no code. Both are recorded.
  --
  -- Not a foreign key, for the same reason as sheet_members.member_story_id: a stale id
  -- must be reported, never rejected with an opaque constraint error at insert time.
  ALTER TABLE threads ADD COLUMN seen_on_story_id TEXT;
  CREATE INDEX idx_threads_seen_on ON threads(seen_on_story_id);
  `,

  // v4 — build storage recorded relative to the data directory.
  `
  -- storage_path was written absolute, which makes it a record of where this machine
  -- happened to keep its data rather than of where the build lives. Back the volume up
  -- and restore it anywhere else — a new host, a renamed mount, a copy of production
  -- pulled down to look at locally — and every row still names the old location. The
  -- failure is quiet and convincing: the reviewer shell loads, the sidebar fills, the
  -- counts are right, and every story renders nothing, because each asset 404s.
  --
  -- ingestBuildZip has only ever written path.join(dataDir, 'builds', buildId), so the
  -- relative form is derivable from the id. The LIKE guard keeps the rewrite to rows of
  -- exactly that shape; anything else is left alone and still resolves, because
  -- buildFilePath resolves against the data directory and path.resolve ignores the base
  -- for a value that is already absolute.
  UPDATE builds SET storage_path = 'builds/' || id
   WHERE storage_path LIKE '%/builds/' || id;
  `,

  // v5 — the review unit is the component, not the story variant.
  `
  -- A reviewer looking at a contact sheet judges "SideNav", not "SideNav / Grouped".
  -- The tile is labelled with the component, and what it renders is usually a bespoke
  -- composition rather than any one story. Filing that decision against whichever
  -- variant the tile happened to name recorded a judgement nobody made, and left the
  -- component's other variants unreviewed forever — 277 of them in the reference
  -- Storybook, in a queue no one will ever walk.
  --
  -- The component is the CSF file: verified 1:1 with title across a real 639-story
  -- build (186 files, 186 titles, no file with two titles, no title across two files).
  -- import_path is therefore the grouping key and needs no new column; this stores the
  -- component's own title for display, since stories.title carries the variant appended.
  ALTER TABLE stories ADD COLUMN component_title TEXT NOT NULL DEFAULT '';
  CREATE INDEX idx_stories_import_path ON stories(import_path);
  `,
];

/** Schema version a freshly-opened database lands on. Derived, so tests assert the
 *  migration ran rather than pinning a number that every new migration invalidates. */
export const SCHEMA_VERSION = MIGRATIONS.length;

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

/**
 * Bring `db` up to the last migration in `migrations`, one transaction per step, so an
 * interrupted upgrade lands on a version that exists rather than between two.
 *
 * `migrations` is a parameter so the harness itself can be tested against synthetic
 * steps. Production callers take the default.
 */
export function migrate(db: DB, migrations: readonly Migration[] = MIGRATIONS): void {
  // A database written by a newer Greenroom than this one. The loop below would simply
  // not run, and the server would come up and start writing against a schema whose
  // shape it does not know — worse than refusing to start.
  const opening = db.pragma('user_version', { simple: true }) as number;
  if (opening > migrations.length) {
    throw new Error(
      `database is at schema v${opening}, newer than this build understands (v${migrations.length}). ` +
        'Upgrade Greenroom, or point it at a different data directory.',
    );
  }
  if (opening === migrations.length) return;

  /*
   * Foreign-key enforcement is disabled around the whole run, and it has to happen here,
   * outside the transaction, because `PRAGMA foreign_keys` is a no-op inside one. Not an
   * error and not a warning — the setting silently stays as it was. Written inside the
   * transaction that needs it, it reads as correct in review and does nothing at runtime.
   *
   * It is disabled for exactly one reason: while enforcement is on, DROP TABLE performs
   * an implicit DELETE FROM, so dropping a table whose rows another table references
   * fails outright with `FOREIGN KEY constraint failed`. That blocks a table rebuild,
   * which is the only way to change a primary key — v2 needed one, and story identity
   * will need another.
   *
   * It buys nothing else. In particular it does NOT stop `ALTER TABLE … RENAME TO` from
   * rewriting other tables' REFERENCES clauses to follow the new name. SQLite documents
   * that as gated on this pragma and it was — 3.51.0 still gates it — but as of the 3.53
   * series the rename rewrites them either way, verified on the 3.53.4 that better-sqlite3
   * bundles. Only `legacy_alter_table` suppresses it now.
   *
   * So rebuild by renaming the replacement INTO the original name: create `x_next`, copy,
   * DROP `x`, rename `x_next` to `x`. Never rename the original out of the way first. In
   * the first spelling no other table's REFERENCES clause ever names the table being
   * renamed, so there is nothing to rewrite and every clause still resolves to the
   * replacement. In the second, every child is silently repointed at the table that is
   * about to be dropped — and `foreign_key_check` cannot see it, because it walks rows: a
   * child table with no rows, which is every fresh install, reports clean while its schema
   * names a table that no longer exists. That is what `assertSchemaIntact` catches.
   */
  const enforced = db.pragma('foreign_keys', { simple: true }) === 1;
  if (enforced) db.pragma('foreign_keys = OFF');
  let completed = false;
  try {
    for (;;) {
      let target: number | null = null;
      try {
        const applied = db
          .transaction(() => {
            /*
             * The version is re-read here, inside the write lock an IMMEDIATE transaction
             * takes at BEGIN, rather than latched once before the loop. Two processes can
             * open the same data directory — a rolling deploy where the new container
             * mounts the volume before the old one exits, or a restart racing a slow
             * shutdown — and both would otherwise latch the version they saw before either
             * began. The second then replays steps the first already applied: an
             * idempotent one succeeds and writes a version BELOW the schema, a
             * non-idempotent one throws. Either way the database is left claiming a
             * version its schema has already passed, and no later run can repair it,
             * because the step it replays throws every time from then on.
             */
            const v = db.pragma('user_version', { simple: true }) as number;
            if (v >= migrations.length) return false;
            target = v + 1;

            const step = migrations[v]!;
            if (typeof step === 'string') {
              db.exec(step);
            } else {
              const returned = step(db);
              if (returned !== undefined) throw new Error(ASYNC_STEP);
            }
            assertSchemaIntact(db);
            db.pragma(`user_version = ${v + 1}`);
            return true;
          })
          .immediate();
        if (!applied) break;
      } catch (cause) {
        const where = target === null ? 'migration failed' : `migration to schema v${target} failed`;
        throw new Error(`${where}: ${cause instanceof Error ? cause.message : String(cause)}`, {
          cause,
        });
      }
    }
    completed = true;
  } finally {
    if (enforced) {
      try {
        db.pragma('foreign_keys = ON');
      } catch (restoreError) {
        // Only worth raising if the run itself succeeded. Thrown from a finally while a
        // migration failure is already unwinding, it would replace the real cause — and
        // the only realistic way this throws is a connection that is already gone.
        if (completed) throw restoreError;
      }
    }
  }
}

const ASYNC_STEP =
  'migration step returned a value; steps must be synchronous. An async step is never ' +
  'awaited: its transaction commits and the schema version advances before the step has ' +
  'done anything, its writes then land outside any transaction and outside the integrity ' +
  'check, and its failure surfaces as an unhandled rejection with the version already ' +
  'recorded as applied — so it never runs again. Use the synchronous fs calls.';

/** Two checks with complementary blind spots, run after every step. */
function assertSchemaIntact(db: DB) {
  assertReferenceTargetsExist(db);
  assertNoDanglingRows(db);
}

/** Every REFERENCES clause must name a table that exists. `foreign_key_check` walks rows,
 *  so it returns clean for a child table that is empty — which is the normal state of a
 *  fresh install — even when the parent it names has been dropped. Reading the schema
 *  instead catches that before it commits. */
function assertReferenceTargetsExist(db: DB) {
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => t.name.toLowerCase()),
  );
  const broken: string[] = [];
  for (const name of tables) {
    const fks = db.pragma(`foreign_key_list(${JSON.stringify(name)})`) as { table: string }[];
    for (const fk of fks) {
      if (!tables.has(String(fk.table).toLowerCase())) broken.push(`${name} → ${fk.table}`);
    }
  }
  if (broken.length > 0) {
    throw new Error(`left a reference to a table that does not exist: ${broken.join(', ')}`);
  }
}

/** Checks every foreign key in the database against its parent. `foreign_key_check`
 *  returns one row per violation and nothing at all when the rows are intact — and it
 *  sees the current transaction's own uncommitted writes, which is what makes it usable
 *  as a gate before commit rather than a report after one. */
function assertNoDanglingRows(db: DB) {
  const violations = db.pragma('foreign_key_check') as {
    table: string;
    rowid: number | null;
    parent: string;
    fkid: number;
  }[];
  if (violations.length === 0) return;
  const shown = violations
    .slice(0, 5)
    .map((v) => `${v.table}(rowid ${v.rowid}) → ${v.parent}`)
    .join(', ');
  const rest = violations.length > 5 ? `, and ${violations.length - 5} more` : '';
  throw new Error(`left ${violations.length} dangling reference(s): ${shown}${rest}`);
}
