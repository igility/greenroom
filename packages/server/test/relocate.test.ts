import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import type { Principal } from '@igility/greenroom-shared';

/**
 * A backup is only a backup if it restores somewhere else.
 *
 * `builds.storage_path` used to be written absolute, which recorded where this machine
 * kept its data rather than where the build lives. Restoring the volume onto a new host,
 * a renamed mount, or a laptop looking at a copy of production left every row naming a
 * directory that was not there — and the failure was quiet and convincing, because the
 * review history is in the database and loads perfectly. The shell came up, the sidebar
 * filled, the counts were right, and every story rendered nothing.
 */

const ADMIN: Principal = { kind: 'admin', id: 'tok-1', name: 'Uploader' };
const enc = (s: string) => new TextEncoder().encode(s);
const storybookZip = () =>
  zipSync({
    'index.json': enc(
      JSON.stringify({
        v: 5,
        entries: {
          'components-button--primary': {
            type: 'story',
            title: 'Components/Button',
            name: 'Primary',
            importPath: './src/Button.stories.tsx',
            exportName: 'Primary',
          },
        },
      }),
    ),
    'iframe.html': enc('<html><body>the build</body></html>'),
  });

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-relocate-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Everything a whole-volume snapshot would carry, moved to a new location. */
function relocate(from: string, to: string) {
  fs.cpSync(from, to, { recursive: true });
  fs.rmSync(from, { recursive: true, force: true });
}

describe('a data directory that moves', () => {
  it('records build storage relative to the data directory', () => {
    const dataDir = path.join(root, 'first');
    const db = openDb(dataDir);
    const store = new Store(db, dataDir);
    const { build } = store.ingestBuildZip(storybookZip(), { label: 'round-1' }, ADMIN);

    const stored = (
      db.prepare('SELECT storage_path FROM builds WHERE id = ?').get(build.id) as {
        storage_path: string;
      }
    ).storage_path;
    expect(stored).toBe(path.join('builds', build.id));
    expect(path.isAbsolute(stored)).toBe(false);
    db.close();
  });

  it('still serves every build asset after the directory is restored elsewhere', () => {
    const original = path.join(root, 'original');
    const first = openDb(original);
    const { build } = new Store(first, original).ingestBuildZip(storybookZip(), { label: 'r1' }, ADMIN);
    first.close();

    const restored = path.join(root, 'restored');
    relocate(original, restored);

    const db = openDb(restored);
    const store = new Store(db, restored);
    const iframe = store.buildFilePath(build.id, 'iframe.html');

    expect(iframe.startsWith(restored)).toBe(true);
    expect(fs.readFileSync(iframe, 'utf8')).toContain('the build');
    // The review history was never the part at risk — the assets were.
    expect(store.listStories({}).length).toBe(1);
    db.close();
  });

  it('rewrites an absolute path written before v4, on the next open', () => {
    const original = path.join(root, 'original');
    const first = openDb(original);
    const { build } = new Store(first, original).ingestBuildZip(storybookZip(), { label: 'r1' }, ADMIN);
    // Put the row back the way v3 and earlier wrote it, and drop the version so v4 reruns.
    first
      .prepare('UPDATE builds SET storage_path = ? WHERE id = ?')
      .run(path.join(original, 'builds', build.id), build.id);
    // Genuinely restore the v3 shape. Moving user_version alone replays every later
    // migration, and the additive ones then fail on a column that is already there.
    //
    // This undo list grows by a line every time a migration adds a column, which is a
    // real cost and a signal: the test wants "a database as v3 left it" and gets there
    // by building the newest schema and walking it backwards. Seeding forwards with
    // `migrate(db, MIGRATIONS.slice(0, 3))` would be exact and permanent, but the build
    // it relocates is written by `ingestBuildZip`, which needs the current schema — so
    // the backwards walk stays until that coupling is worth unpicking.
    first.exec('ALTER TABLE stories DROP COLUMN component_title');
    first.exec('DROP INDEX IF EXISTS idx_stories_import_path');
    first.exec('DROP INDEX IF EXISTS idx_sessions_magic_link');
    first.exec('ALTER TABLE sessions DROP COLUMN magic_link_token');
    first.pragma('user_version = 3');
    first.close();

    const restored = path.join(root, 'restored');
    relocate(original, restored);

    const db = openDb(restored);
    expect(
      (db.prepare('SELECT storage_path FROM builds WHERE id = ?').get(build.id) as {
        storage_path: string;
      }).storage_path,
    ).toBe(path.join('builds', build.id));
    expect(
      fs.readFileSync(new Store(db, restored).buildFilePath(build.id, 'iframe.html'), 'utf8'),
    ).toContain('the build');
    db.close();
  });

  it('leaves a path it does not recognise alone, and resolves it anyway', () => {
    // The v4 rewrite is guarded to the one shape ingest has ever written. Anything else
    // keeps working because buildFilePath resolves against the data directory, and
    // path.resolve ignores that base when the stored value is already absolute.
    const dataDir = path.join(root, 'odd');
    const db = openDb(dataDir);
    const store = new Store(db, dataDir);
    const { build } = store.ingestBuildZip(storybookZip(), { label: 'r1' }, ADMIN);

    const elsewhere = path.join(root, 'somewhere-else');
    fs.cpSync(path.join(dataDir, 'builds', build.id), elsewhere, { recursive: true });
    db.prepare('UPDATE builds SET storage_path = ? WHERE id = ?').run(elsewhere, build.id);
    db.exec('ALTER TABLE stories DROP COLUMN component_title');
    db.exec('DROP INDEX IF EXISTS idx_stories_import_path');
    db.exec('DROP INDEX IF EXISTS idx_sessions_magic_link');
    db.exec('ALTER TABLE sessions DROP COLUMN magic_link_token');
    db.pragma('user_version = 3');
    db.close();

    const reopened = openDb(dataDir);
    expect(
      (reopened.prepare('SELECT storage_path FROM builds WHERE id = ?').get(build.id) as {
        storage_path: string;
      }).storage_path,
    ).toBe(elsewhere);
    expect(
      fs.readFileSync(
        new Store(reopened, dataDir).buildFilePath(build.id, 'iframe.html'),
        'utf8',
      ),
    ).toContain('the build');
    reopened.close();
  });
});
