import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../src/db.js';
import { Store, titleGroup, pathGroup } from '../src/store.js';
import { HttpError } from '../src/util.js';
import type { Principal } from '@igility/greenroom-shared';

/**
 * The upload gate.
 *
 * Origin, 2026-08-19: four builds went up with the host project's scope variable unset,
 * which its own config defines as "publish everything". 245 unreviewed stories — two
 * entire unpresented workstreams — landed on a client's review surface, and nothing in
 * Greenroom noticed, because upload zipped a directory and posted it. A person reading
 * the published index.json found it two hours later.
 *
 * The first version of this gate asked "are you sure?", which everybody always is. So the
 * override is a CLAIM instead: name what is being added, and a name that does not match
 * the artifact fails. A scope lets that claim be written in the project's own words —
 * `batch2` — which is the version that does not decay, because shipping staff-admin while
 * claiming `batch2` is a false statement rather than an extra keystroke.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const admin: Principal = { kind: 'admin', id: 'a', name: 'Admin' };

interface S {
  id: string;
  title: string;
  importPath: string;
}

/** `n` stories inside one reviewer-facing section, sourced from one directory. */
const inSection = (group: string, dir: string, n: number, prefix: string): S[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}--default`,
    title: `${group}/Item ${i}`,
    importPath: `./stories/${dir}/Item${i}.stories.tsx`,
  }));

const buildOf = (items: S[], marker = 'x') =>
  zipSync({
    'index.json': enc(
      JSON.stringify({
        v: 5,
        entries: Object.fromEntries(
          items.map((s) => [
            s.id,
            { type: 'story', title: s.title, name: 'Default', importPath: s.importPath, tags: ['dev'] },
          ]),
        ),
      }),
    ),
    'iframe.html': enc(`<html>${marker}</html>`),
  });

/** The shape of the real project: a components surface, and page sections in batches. */
const COMPONENTS = inSection('Components/Forms', 'components/forms', 40, 'c');
const CLINICAL = inSection('Pages/Clinical', 'pages/clinical', 46, 'cl');
const COMMERCE = inSection('Pages/Commerce', 'pages/commerce', 33, 'co');
const INTAKE = inSection('Pages/Intake', 'pages/intake-assessment', 59, 'in');

let dataDir: string;
let store: Store;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-gate-'));
  store = new Store(openMemoryDb(), dataDir);
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const upload = (items: S[], label: string, claims = {}, marker = label) =>
  store.ingestBuildZip(buildOf(items, marker), { label, ...claims }, admin);

describe('deriving what a reviewer would call a block of stories', () => {
  it('groups by the sidebar hierarchy, not by file layout', () => {
    expect(titleGroup('Pages/Clinical/C03 Visit Summary')).toBe('Pages/Clinical');
    expect(titleGroup('Start here')).toBe('Start here');
    expect(pathGroup('./stories/pages/clinical/C03.stories.tsx')).toBe('stories/pages/clinical');
  });
});

describe('the first build', () => {
  it('passes without a word, having nothing to disturb', () => {
    const r = upload(COMPONENTS, 'first');
    expect(r.created).toBe(true);
    expect(r.delta!.liveBuild).toBeNull();
    expect(r.delta!.concerns).toEqual([]);
  });
});

describe('routine work is not interrupted', () => {
  it('lets a small addition through, and still reports it', () => {
    upload(COMPONENTS, 'v1');
    // Three new stories on a surface of forty. Gating this would train whoever deploys to
    // claim every time, and a claim made every time stops being read.
    const r = upload([...COMPONENTS, ...inSection('Components/Forms', 'components/forms', 3, 'n')], 'v2');
    expect(r.created).toBe(true);
    expect(r.delta!.concerns).toEqual([]);
    expect(r.delta!.added).toHaveLength(3);
  });

  it('reports the delta on every successful upload, not only on a refusal', () => {
    upload(COMPONENTS, 'v1');
    const r = upload([...COMPONENTS, ...inSection('Components/Forms', 'components/forms', 1, 'n')], 'v2');
    expect(r.delta!.liveBuild!.label).toBe('v1');
    expect(r.delta!.liveCount).toBe(40);
  });
});

describe('the failure that caused this', () => {
  it('refuses a build that floods the surface, naming the sections nobody claimed', () => {
    upload(COMPONENTS, 'components');
    let err: HttpError | undefined;
    try {
      upload([...COMPONENTS, ...CLINICAL, ...COMMERCE], 'scope-unset');
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.status).toBe(409);
    expect(err?.reason).toBe('story-set-changed');
    // The names are the point. "79 stories added" would not have told me anything;
    // "Pages/Clinical" in a components deploy would have.
    expect(err?.message).toMatch(/Pages\/Clinical \(46\)/);
    expect(err?.message).toMatch(/Pages\/Commerce \(33\)/);
  });

  it('leaves nothing behind when it refuses', () => {
    upload(COMPONENTS, 'v1');
    const before = fs.readdirSync(path.join(dataDir, 'builds'));
    expect(() => upload([...COMPONENTS, ...CLINICAL], 'v2')).toThrow(HttpError);
    expect(store.listBuilds()).toHaveLength(1);
    expect(fs.readdirSync(path.join(dataDir, 'builds'))).toEqual(before);
  });
});

describe('the claim', () => {
  it('lets the build through when it names every section being added', () => {
    upload(COMPONENTS, 'v1');
    const r = upload([...COMPONENTS, ...CLINICAL, ...COMMERCE], 'batch-2', {
      allowAdded: ['Pages/Clinical', 'Pages/Commerce'],
    });
    expect(r.created).toBe(true);
    expect(r.delta!.addedGroups.map((g) => g.group).sort()).toEqual([
      'Pages/Clinical',
      'Pages/Commerce',
    ]);
  });

  it('still refuses when the claim covers only part of what is arriving', () => {
    // The exact shape of the mistake: intending batch 2, actually shipping batch 2 and
    // something else. A blanket confirmation passes this; a claim does not.
    upload(COMPONENTS, 'v1');
    expect(() =>
      upload([...COMPONENTS, ...CLINICAL, ...COMMERCE, ...INTAKE], 'oops', {
        allowAdded: ['Pages/Clinical', 'Pages/Commerce'],
      }),
    ).toThrow(/Pages\/Intake \(59\)/);
  });

  it('refuses a claim that names the wrong thing entirely', () => {
    upload(COMPONENTS, 'v1');
    expect(() =>
      upload([...COMPONENTS, ...CLINICAL], 'mislabelled', { allowAdded: ['Pages/Commerce'] }),
    ).toThrow(/Pages\/Clinical/);
  });

  it('reports a claim that matches nothing, without failing on it', () => {
    // A named scope routinely covers sections already live, so this cannot be fatal. It
    // is still worth saying: it also describes believing you built something you did not.
    upload(COMPONENTS, 'v1');
    const r = upload([...COMPONENTS, ...CLINICAL], 'v2', {
      allowAdded: ['Pages/Clinical', 'Pages/Nonexistent'],
    });
    expect(r.created).toBe(true);
    expect(r.delta!.unmatchedClaims).toEqual(['Pages/Nonexistent']);
  });
});

describe('a scope, so the claim is written in the project\'s own words', () => {
  it('resolves a scope name to its sections', () => {
    store.setScope('batch2', ['Pages/Clinical', 'Pages/Commerce'], admin);
    upload(COMPONENTS, 'v1');
    const r = upload([...COMPONENTS, ...CLINICAL, ...COMMERCE], 'batch-2', {
      allowAdded: ['batch2'],
    });
    expect(r.created).toBe(true);
  });

  it('fails when the build carries something the scope does not name', () => {
    // This is the property the whole design exists for. "batch2" is a sentence about what
    // the client has been shown, and shipping intake under it is false rather than lazy.
    store.setScope('batch2', ['Pages/Clinical', 'Pages/Commerce'], admin);
    upload(COMPONENTS, 'v1');
    expect(() =>
      upload([...COMPONENTS, ...CLINICAL, ...COMMERCE, ...INTAKE], 'wrong', {
        allowAdded: ['batch2'],
      }),
    ).toThrow(/Pages\/Intake/);
  });

  it('tolerates a scope whose other sections are already live', () => {
    store.setScope('batch2', ['Pages/Clinical', 'Pages/Commerce'], admin);
    upload([...COMPONENTS, ...COMMERCE], 'v1');
    const r = upload([...COMPONENTS, ...COMMERCE, ...CLINICAL], 'v2', { allowAdded: ['batch2'] });
    expect(r.created).toBe(true);
    expect(r.delta!.unmatchedClaims).toEqual(['Pages/Commerce']);
  });

  it('survives being redefined, and can be removed', () => {
    store.setScope('batch2', ['Pages/Clinical'], admin);
    store.setScope('batch2', ['Pages/Clinical', 'Pages/Commerce'], admin);
    expect(store.listScopes()[0]!.groups).toEqual(['Pages/Clinical', 'Pages/Commerce']);
    expect(store.deleteScope('batch2')).toBe(true);
    expect(store.listScopes()).toEqual([]);
  });
});

describe('stories disappearing', () => {
  it('refuses any removal, however small, until it is claimed', () => {
    upload([...COMPONENTS, ...CLINICAL], 'v1');
    expect(() => upload(COMPONENTS, 'v2')).toThrow(/Pages\/Clinical/);
    const r = upload(COMPONENTS, 'v2', { allowRemoved: ['Pages/Clinical'] }, 'v2b');
    expect(r.created).toBe(true);
  });

  it('names the comments that would go unreachable', () => {
    upload([...COMPONENTS, ...CLINICAL], 'v1');
    const build = store.latestBuild()!;
    store.createThread({ storyId: 'cl0--default', buildId: build.id, body: 'change this' }, admin);
    let err: HttpError | undefined;
    try {
      upload(COMPONENTS, 'v2');
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.message).toMatch(/1 disappearing story carries 1 open comment/);
    const delta = err?.details as { removed: { storyId: string; openThreads: number }[] };
    expect(delta.removed.find((r) => r.storyId === 'cl0--default')).toMatchObject({
      openThreads: 1,
    });
  });

  it('names a sign-off that would be dropped', () => {
    upload([...COMPONENTS, ...CLINICAL], 'v1');
    const build = store.latestBuild()!;
    store.setStoryState('cl0--default', 'approved', admin, { buildId: build.id });
    expect(() => upload(COMPONENTS, 'v2')).toThrow(/1 approved story is dropped/);
  });
});

describe('when the sidebar and the file tree disagree', () => {
  it('reports a directory that carries more than one section', () => {
    // The real case: 32 stories titled Pages/Marketing live in pages/system-utility, so a
    // build scoped by DIRECTORY ships marketing to anyone told the batch is utilities.
    upload(COMPONENTS, 'v1');
    const marketing = inSection('Pages/Marketing', 'pages/system-utility', 20, 'mk');
    const utility = inSection('Pages/System', 'pages/system-utility', 20, 'sy');
    const r = upload([...COMPONENTS, ...marketing, ...utility], 'batch-3', {
      allowAdded: ['Pages/Marketing', 'Pages/System'],
    });
    expect(r.delta!.groupMismatches.join(' ')).toMatch(
      /stories\/pages\/system-utility carries more than one section: Pages\/Marketing, Pages\/System/,
    );
  });
});

describe('the blunt override still exists', () => {
  it('permits anything, and asserts nothing', () => {
    upload(COMPONENTS, 'v1');
    const r = upload([...COMPONENTS, ...CLINICAL], 'v2', { allowStoryChanges: true });
    expect(r.created).toBe(true);
  });
});

describe('what "live" means', () => {
  it('compares against the build a reviewer lands on, not everything ever uploaded', () => {
    upload([...COMPONENTS, ...CLINICAL], 'v1');
    upload(COMPONENTS, 'v2', { allowRemoved: ['Pages/Clinical'] });
    // Clinical is back. Against the LIVE surface that is an addition, which is the honest
    // answer; against the accumulated stories table it would look like nothing happened.
    const r = upload([...COMPONENTS, ...CLINICAL], 'v3', { allowAdded: ['Pages/Clinical'] });
    expect(r.delta!.addedGroups.map((g) => g.group)).toEqual(['Pages/Clinical']);
    expect(r.delta!.liveCount).toBe(40);
  });
});
