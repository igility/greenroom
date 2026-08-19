import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { HttpError } from '../src/util.js';
import type { Principal } from '@igility/greenroom-shared';

/**
 * The upload gate.
 *
 * Origin, 2026-08-19: four builds went up with the host project's scope variable unset,
 * which its own config defines as "publish everything". The result put 245 unreviewed
 * stories — two entire unpresented workstreams — in front of a client, and nothing in
 * Greenroom noticed, because upload zipped a directory and posted it. A person reading
 * the published index.json found it, roughly two hours later.
 *
 * So the gate answers one question the caller cannot be trusted to answer for itself:
 * what does this upload change about what the reviewer can see? It lives in the store
 * rather than the CLI because the CLI is not the only caller — the MCP server and any
 * agent holding an admin key post to the same route.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const admin: Principal = { kind: 'admin', id: 'a', name: 'Admin' };

/** A build of `n` components, optionally with extra story ids appended. */
const buildOf = (ids: string[], marker = 'x') =>
  zipSync({
    'index.json': enc(
      JSON.stringify({
        v: 5,
        entries: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              type: 'story',
              title: `Components/${id}`,
              name: 'Default',
              importPath: `./src/components/${id}.stories.tsx`,
              tags: ['dev'],
            },
          ]),
        ),
      }),
    ),
    'iframe.html': enc(`<html>${marker}</html>`),
  });

const ids = (n: number, prefix = 'c') => Array.from({ length: n }, (_, i) => `${prefix}${i}--default`);

let dataDir: string;
let store: Store;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-gate-'));
  store = new Store(openMemoryDb(), dataDir);
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const upload = (zip: Uint8Array, label: string, allow = false) =>
  store.ingestBuildZip(zip, { label, allowStoryChanges: allow }, admin);

describe('the first build', () => {
  it('passes without a word, having nothing to disturb', () => {
    const r = upload(buildOf(ids(40)), 'first');
    expect(r.created).toBe(true);
    expect(r.delta!.liveBuild).toBeNull();
    expect(r.delta!.concerns).toEqual([]);
  });
});

describe('routine work is not interrupted', () => {
  it('lets a small addition through, and still reports it', () => {
    upload(buildOf(ids(40)), 'v1');
    // Three new stories on a surface of forty. Gating this would train whoever deploys
    // to pass the override every time, and an override always passed is not a gate.
    const r = upload(buildOf([...ids(40), ...ids(3, 'new')]), 'v2');
    expect(r.created).toBe(true);
    expect(r.delta!.concerns).toEqual([]);
    expect(r.delta!.added.map((a) => a.storyId)).toEqual([
      'new0--default',
      'new1--default',
      'new2--default',
    ]);
    expect(r.delta!.removed).toEqual([]);
  });

  it('reports the delta on every successful upload, not only on a refusal', () => {
    // A report that appears only when something is wrong teaches nobody what normal
    // looks like — and the operator never learns to read it.
    upload(buildOf(ids(40)), 'v1');
    const r = upload(buildOf([...ids(40), 'extra--default']), 'v2');
    expect(r.delta).not.toBeNull();
    expect(r.delta!.liveBuild!.label).toBe('v1');
    expect(r.delta!.liveCount).toBe(40);
    expect(r.delta!.incomingCount).toBe(41);
  });
});

describe('the failure that caused this', () => {
  it('refuses a build that floods the surface with unreviewed stories', () => {
    upload(buildOf(ids(427)), 'round-2');
    // The shape of the real incident: 427 → 672 in one upload.
    let err: HttpError | undefined;
    try {
      upload(buildOf([...ids(427), ...ids(245, 'page')]), 'scope-unset');
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.status).toBe(409);
    expect(err?.reason).toBe('story-set-changed');
    expect(err?.message).toMatch(/245 stories are added to a surface of 427/);
  });

  it('leaves nothing behind when it refuses', () => {
    // A refusal that half-wrote would be worse than no gate: the tree on disk would
    // exist without a row pointing at it, and the next upload would dedupe against it.
    upload(buildOf(ids(40)), 'v1');
    const before = fs.readdirSync(path.join(dataDir, 'builds'));
    expect(() => upload(buildOf([...ids(40), ...ids(50, 'flood')]), 'v2')).toThrow(HttpError);
    expect(store.listBuilds()).toHaveLength(1);
    expect(fs.readdirSync(path.join(dataDir, 'builds'))).toEqual(before);
  });

  it('goes through when the change is acknowledged', () => {
    upload(buildOf(ids(40)), 'v1');
    const r = upload(buildOf([...ids(40), ...ids(50, 'flood')]), 'v2', true);
    expect(r.created).toBe(true);
    // Acknowledged, not hidden — the delta still comes back so it can be logged.
    expect(r.delta!.added).toHaveLength(50);
  });
});

describe('stories disappearing', () => {
  it('refuses any removal, however small', () => {
    upload(buildOf(ids(40)), 'v1');
    expect(() => upload(buildOf(ids(39)), 'v2')).toThrow(/1 story disappears/);
  });

  it('names the comments that would go unreachable', () => {
    upload(buildOf(ids(40)), 'v1');
    const build = store.latestBuild()!;
    store.createThread(
      { storyId: 'c39--default', buildId: build.id, body: 'this needs to change' },
      admin,
    );
    let err: HttpError | undefined;
    try {
      upload(buildOf(ids(39)), 'v2');
    } catch (e) {
      err = e as HttpError;
    }
    // The reason removals are gated at all: the thread survives in the database and
    // becomes unreachable on the surface, which reads as deleted feedback.
    expect(err?.message).toMatch(/1 disappearing story carries 1 open comment/);
    const delta = err?.details as { removed: { storyId: string; openThreads: number }[] };
    expect(delta.removed[0]).toMatchObject({ storyId: 'c39--default', openThreads: 1 });
  });

  it('names a sign-off that would be dropped', () => {
    upload(buildOf(ids(40)), 'v1');
    const build = store.latestBuild()!;
    store.setStoryState('c39--default', 'approved', admin, { buildId: build.id });
    expect(() => upload(buildOf(ids(39)), 'v2')).toThrow(/1 approved story is dropped/);
  });
});

describe('what "live" means', () => {
  it('compares against the build a reviewer lands on, not everything ever uploaded', () => {
    // c40 existed in v1 and was dropped in v2. Re-adding it in v3 is an ADDITION, because
    // the surface a reviewer can currently see does not contain it. Comparing against the
    // whole stories table instead would call this unchanged and miss the growth.
    upload(buildOf([...ids(40), 'c40--default'], 'one'), 'v1');
    upload(buildOf(ids(40), 'two'), 'v2', true);
    const r = upload(buildOf([...ids(40), 'c40--default'], 'three'), 'v3');
    expect(r.delta!.added.map((a) => a.storyId)).toEqual(['c40--default']);
    expect(r.delta!.liveCount).toBe(40);
  });
});
