import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS, migrate, openDb } from '../src/db.js';
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

/**
 * A data directory exactly as v3 left it: the build files on disk, and a `builds` row
 * carrying the ABSOLUTE `storage_path` that v3 and earlier wrote.
 *
 * Built forwards, by running the first three migrations, rather than by opening the
 * current schema and undoing everything since. The backwards walk needed a new line for
 * every migration that added a column — it was patched for v5, then v8, then v9 — and a
 * fixture that only gets corrected when it happens to break is a fixture that quietly
 * stops representing the thing it claims to. `ingestBuildZip` cannot help here because
 * it needs the current schema, so the row and the files are written directly.
 */
function seedV3(dataDir: string, buildId: string) {
  const buildDir = path.join(dataDir, 'builds', buildId);
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'iframe.html'), '<html><body>the build</body></html>');
  const db = new Database(path.join(dataDir, 'greenroom.db'));
  db.pragma('journal_mode = WAL');
  migrate(db, MIGRATIONS.slice(0, 3), { dataDir });
  db.prepare(
    `INSERT INTO builds (id, manifest_hash, label, git_sha, story_count, storage_path, created_at)
     VALUES (?, ?, 'r1', NULL, 0, ?, '2026-01-01T00:00:00.000Z')`,
  ).run(buildId, `h-${buildId}`, buildDir);
  db.close();
  return buildDir;
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
    const buildId = 'b-pre-v4';
    seedV3(original, buildId);

    const restored = path.join(root, 'restored');
    relocate(original, restored);

    const db = openDb(restored);
    expect(
      (db.prepare('SELECT storage_path FROM builds WHERE id = ?').get(buildId) as {
        storage_path: string;
      }).storage_path,
    ).toBe(path.join('builds', buildId));
    expect(
      fs.readFileSync(new Store(db, restored).buildFilePath(buildId, 'iframe.html'), 'utf8'),
    ).toContain('the build');
    db.close();
  });

  it('leaves a path it does not recognise alone, and resolves it anyway', () => {
    // The v4 rewrite is guarded to the one shape ingest has ever written. Anything else
    // keeps working because buildFilePath resolves against the data directory, and
    // path.resolve ignores that base when the stored value is already absolute.
    const dataDir = path.join(root, 'odd');
    const buildId = 'b-odd';
    seedV3(dataDir, buildId);

    const elsewhere = path.join(root, 'somewhere-else');
    fs.cpSync(path.join(dataDir, 'builds', buildId), elsewhere, { recursive: true });
    const seeded = new Database(path.join(dataDir, 'greenroom.db'));
    seeded.prepare('UPDATE builds SET storage_path = ? WHERE id = ?').run(elsewhere, buildId);
    seeded.close();

    const reopened = openDb(dataDir);
    expect(
      (reopened.prepare('SELECT storage_path FROM builds WHERE id = ?').get(buildId) as {
        storage_path: string;
      }).storage_path,
    ).toBe(elsewhere);
    expect(
      fs.readFileSync(new Store(reopened, dataDir).buildFilePath(buildId, 'iframe.html'), 'utf8'),
    ).toContain('the build');
    reopened.close();
  });
});
