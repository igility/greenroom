import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, type DB, type Migration } from '../src/db.js';

/**
 * The migration runner itself, against synthetic steps.
 *
 * `migrate.test.ts` covers the real chain against a populated v1 database. This file
 * covers the machinery underneath it: the function seam, and the two SQLite behaviours
 * that make the obvious loop quietly wrong — both pinned here as tests, because both
 * look like clutter to anyone who has not watched them bite.
 */

/** A connection in the state `openDb` hands to the runner. */
function open(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

const version = (db: DB) => db.pragma('user_version', { simple: true }) as number;
const enforcing = (db: DB) => db.pragma('foreign_keys', { simple: true }) === 1;
const threadsSql = (db: DB) =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'threads'").get() as { sql: string }).sql;

/** A parent row with a child pointing into it — the shape every rebuild has to survive,
 *  and the shape `threads` → `stories` already has in the real schema. */
const V1 = `
  CREATE TABLE builds (id TEXT PRIMARY KEY, storage_path TEXT NOT NULL);
  CREATE TABLE stories (
    story_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    last_seen_build_id TEXT NOT NULL REFERENCES builds(id)
  );
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL REFERENCES stories(story_id)
  );
  INSERT INTO builds VALUES ('b1', '/does-not-exist');
  INSERT INTO stories VALUES ('components-button--primary', 'Components/Button', 'b1');
  INSERT INTO threads VALUES ('t1', 'components-button--primary');
`;

/** The same, before anyone has left a comment — the state of every fresh install, and the
 *  state in which a row-walking integrity check has nothing to walk. */
const V1_NO_THREADS = V1.replace(
  "INSERT INTO threads VALUES ('t1', 'components-button--primary');",
  '',
);

/** The v2 fingerprints change in miniature. SQLite cannot add a column to a primary key
 *  in place, so the table is built alongside and renamed over the original. */
const REBUILD_STORIES = `
  CREATE TABLE stories_next (
    story_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    last_seen_build_id TEXT NOT NULL REFERENCES builds(id),
    export_name TEXT
  );
  INSERT INTO stories_next (story_id, title, last_seen_build_id)
    SELECT story_id, title, last_seen_build_id FROM stories;
  DROP TABLE stories;
  ALTER TABLE stories_next RENAME TO stories;
`;

/** The same rebuild, written by someone who forgot to carry the rows over. `threads.t1`
 *  is left pointing at a story that no longer exists. */
const REBUILD_LOSING_THE_ROWS = REBUILD_STORIES.replace(
  'SELECT story_id, title, last_seen_build_id FROM stories',
  'SELECT story_id, title, last_seen_build_id FROM stories WHERE 0',
);

/** The other standard rebuild spelling — rename the original out of the way instead of
 *  renaming the replacement into place. It carries every row correctly and is still
 *  wrong: on SQLite >= 3.53 the first ALTER repoints `threads` at `stories_old`
 *  regardless of the foreign_keys pragma, and `stories_old` is then dropped. */
const REBUILD_BY_RENAMING_AWAY = `
  ALTER TABLE stories RENAME TO stories_old;
  CREATE TABLE stories (
    story_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    last_seen_build_id TEXT NOT NULL REFERENCES builds(id),
    export_name TEXT
  );
  INSERT INTO stories (story_id, title, last_seen_build_id)
    SELECT story_id, title, last_seen_build_id FROM stories_old;
  DROP TABLE stories_old;
`;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-harness-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('why the runner disables foreign keys, and does it outside the transaction', () => {
  it('ignores PRAGMA foreign_keys inside a transaction, silently', () => {
    const db = open();
    db.exec('BEGIN');
    db.pragma('foreign_keys = OFF');
    // Still on. No error, no warning, no return value to check — which is why issuing
    // this inside the transaction that needs it reviews as correct and does nothing.
    expect(enforcing(db)).toBe(true);
    db.exec('COMMIT');
    db.close();
  });

  it('fails a parent-table rebuild while enforcement is on', () => {
    const db = open();
    db.exec(V1);
    // DROP TABLE performs an implicit DELETE FROM, and `threads` still references the
    // rows it would delete.
    expect(() => db.transaction(() => db.exec(REBUILD_STORIES))()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    db.close();
  });
});

describe('the runner', () => {
  it('completes that rebuild, keeps the child rows, and re-arms enforcement', () => {
    const db = open();
    migrate(db, [V1, REBUILD_STORIES]);

    expect(version(db)).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM threads').get()).toEqual({ n: 1 });
    expect(
      db.prepare('SELECT title, export_name FROM stories WHERE story_id = ?').get(
        'components-button--primary',
      ),
    ).toEqual({ title: 'Components/Button', export_name: null });

    // Enforcement is not merely reported as on — it is enforcing again.
    expect(enforcing(db)).toBe(true);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() =>
      db.prepare('INSERT INTO threads VALUES (?, ?)').run('t2', 'components-button--gone'),
    ).toThrow(/FOREIGN KEY constraint failed/);
    db.close();
  });

  it('runs a function step, which can read stored build output and write the result back', () => {
    // The step that comes next: an export name is recoverable only from the build's own
    // index.json, so the migration has to read a row, read a file, and write a row.
    // There is no seam in `db.exec` where that fits.
    const buildDir = path.join(dir, 'builds', 'b1');
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(
      path.join(buildDir, 'index.json'),
      JSON.stringify({
        v: 5,
        entries: {
          'components-button--primary': {
            type: 'story',
            id: 'components-button--primary',
            title: 'Components/Button',
            importPath: './src/Button.stories.tsx',
            exportName: 'Primary',
          },
        },
      }),
    );

    const backfillExportNames: Migration = (db) => {
      const builds = db.prepare('SELECT id, storage_path FROM builds').all() as {
        id: string;
        storage_path: string;
      }[];
      const set = db.prepare(
        'UPDATE stories SET export_name = ? WHERE story_id = ? AND export_name IS NULL',
      );
      for (const build of builds) {
        const indexPath = path.join(build.storage_path, 'index.json');
        if (!fs.existsSync(indexPath)) continue;
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
          entries: Record<string, { exportName?: string }>;
        };
        for (const [storyId, entry] of Object.entries(index.entries)) {
          if (entry.exportName) set.run(entry.exportName, storyId);
        }
      }
    };

    const db = open();
    // Arrive at v2 first, then point the build at real output, then take the new step —
    // the order a deployed database actually meets a backfill.
    migrate(db, [V1, REBUILD_STORIES]);
    db.prepare('UPDATE builds SET storage_path = ? WHERE id = ?').run(buildDir, 'b1');
    migrate(db, [V1, REBUILD_STORIES, backfillExportNames]);

    // v2 did not run twice — its CREATE TABLE would have thrown if it had.
    expect(version(db)).toBe(3);
    expect(
      db.prepare('SELECT export_name FROM stories WHERE story_id = ?').get(
        'components-button--primary',
      ),
    ).toEqual({ export_name: 'Primary' });
    db.close();
  });

  it('rolls a function step back with its transaction, and leaves the version behind', () => {
    const halfway: Migration = (db) => {
      db.prepare("UPDATE stories SET title = 'rewritten'").run();
      throw new Error('index.json was unreadable');
    };

    const db = open();
    expect(() => migrate(db, [V1, halfway])).toThrow(
      /migration to schema v2 failed: index\.json was unreadable/,
    );
    expect(version(db)).toBe(1);
    expect(
      db.prepare('SELECT title FROM stories WHERE story_id = ?').get('components-button--primary'),
    ).toEqual({ title: 'Components/Button' });
    // Restored even though the run failed — the connection is handed back usable.
    expect(enforcing(db)).toBe(true);
    db.close();
  });

  it('refuses a step that strands a child row, and rolls it back', () => {
    const db = open();
    expect(() => migrate(db, [V1, REBUILD_LOSING_THE_ROWS])).toThrow(
      /migration to schema v2 failed: left 1 dangling reference\(s\): threads\(rowid 1\) → stories/,
    );
    expect(version(db)).toBe(1);
    // The rebuild is undone entirely: the row it dropped is still there.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM stories').get(),
    ).toEqual({ n: 1 });
    expect(enforcing(db)).toBe(true);
    db.close();
  });

  it('catches a rebuild that repoints children at a table it then drops, with no rows to give it away', () => {
    const db = open();
    expect(() => migrate(db, [V1_NO_THREADS, REBUILD_BY_RENAMING_AWAY])).toThrow(
      /left a reference to a table that does not exist: threads → stories_old/,
    );
    expect(version(db)).toBe(1);
    // Rolled back to a schema that still resolves.
    expect(threadsSql(db)).toContain('REFERENCES stories(story_id)');
    db.close();
  });

  it('needed the schema read, because foreign_key_check is blind to that break', () => {
    // Same SQL, run raw. `foreign_key_check` walks rows, and there are none — so it
    // reports a clean database whose schema names a table that does not exist. Under the
    // runner the step above is refused; without the schema read it would have committed.
    const db = open();
    db.pragma('foreign_keys = OFF');
    db.exec(V1_NO_THREADS);
    db.exec(REBUILD_BY_RENAMING_AWAY);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(threadsSql(db)).toContain('"stories_old"');
    db.close();
  });

  it('refuses an async step rather than committing an empty transaction', () => {
    // This assignment typechecks: TypeScript lets a Promise-returning function satisfy a
    // `void` return type, so the seam cannot reject it at compile time. Unawaited, its
    // transaction would commit and the version advance before the step had done anything.
    const asyncBackfill: Migration = async (conn) => {
      conn.prepare("UPDATE stories SET title = 'rewritten'").run();
    };

    const db = open();
    expect(() => migrate(db, [V1, asyncBackfill])).toThrow(/steps must be synchronous/);
    expect(version(db)).toBe(1);
    expect(
      db.prepare('SELECT title FROM stories WHERE story_id = ?').get('components-button--primary'),
    ).toEqual({ title: 'Components/Button' });
    db.close();
  });

  it('holds the write lock before it reads the version, so no other writer can interleave', () => {
    // The step to run is chosen by a version read taken inside the transaction, and that
    // read is only trustworthy if nobody else can write between it and the commit. An
    // IMMEDIATE transaction takes the write lock at BEGIN, before the step touches
    // anything; a DEFERRED one would not take it until the step's first write, leaving a
    // window in which a second process — a rolling deploy, a restart racing a slow
    // shutdown — reads the same version and replays the same step.
    const dbPath = path.join(dir, 'race.db');
    const runner = new Database(dbPath);
    runner.pragma('journal_mode = WAL');
    runner.pragma('foreign_keys = ON');

    const otherProcess = new Database(dbPath);
    otherProcess.pragma('busy_timeout = 0'); // report the contention instead of waiting it out
    otherProcess.exec('CREATE TABLE probe (x)');

    let otherCouldWrite: boolean | null = null;
    // Probes before writing anything itself, so the lock it meets was taken by BEGIN.
    const probesTheLock: Migration = () => {
      try {
        otherProcess.prepare('INSERT INTO probe VALUES (1)').run();
        otherCouldWrite = true;
      } catch {
        otherCouldWrite = false;
      }
    };

    migrate(runner, [probesTheLock]);
    expect(otherCouldWrite).toBe(false);
    expect(version(runner)).toBe(1);
    otherProcess.close();
    runner.close();
  });

  it('gates a function step on integrity too, not just a SQL one', () => {
    // The two headline features meet here: a step that computes in JS and gets it wrong is
    // held to the same check as a step that is SQL.
    const deletesAParent: Migration = (conn) => {
      conn.prepare('DELETE FROM stories').run();
    };
    const db = open();
    expect(() => migrate(db, [V1, deletesAParent])).toThrow(/dangling reference/);
    expect(version(db)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM stories').get()).toEqual({ n: 1 });
    db.close();
  });

  it('stops at the first failing step and does not run the ones after it', () => {
    const boom: Migration = () => {
      throw new Error('nope');
    };
    let reached = false;
    const after: Migration = () => {
      reached = true;
    };

    const db = open();
    expect(() => migrate(db, [V1, boom, after])).toThrow(/schema v2 failed/);
    expect(reached).toBe(false);
    expect(version(db)).toBe(1);
    db.close();
  });

  it('leaves enforcement off when it was off to begin with', () => {
    // The runner restores what it found rather than asserting a house default. Reaching
    // this state takes an explicit pragma: better-sqlite3 turns enforcement on for every
    // connection it opens, unlike SQLite itself, which defaults it off.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    expect(enforcing(db)).toBe(false);
    migrate(db, [V1, REBUILD_STORIES]);
    expect(enforcing(db)).toBe(false);
    expect(version(db)).toBe(2);
    db.close();
  });

  it('is a no-op once the database is current', () => {
    const db = open();
    migrate(db, [V1, REBUILD_STORIES]);
    // Re-running would throw on `CREATE TABLE builds` — that it does not is the proof.
    migrate(db, [V1, REBUILD_STORIES]);
    expect(version(db)).toBe(2);
    db.close();
  });

  it('refuses a database written by a newer schema than it understands', () => {
    const db = open();
    migrate(db, [V1, REBUILD_STORIES]);
    // The same data directory, opened by an older Greenroom. Coming up and writing
    // against a schema of unknown shape is worse than not coming up.
    expect(() => migrate(db, [V1])).toThrow(
      /database is at schema v2, newer than this build understands \(v1\)/,
    );
    db.close();
  });
});
