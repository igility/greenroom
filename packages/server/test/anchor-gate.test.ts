import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../src/db.js';
import { Store, anchorInSelector } from '../src/store.js';
import { HttpError } from '../src/util.js';
import { ANCHOR_MANIFEST_FILE, type Principal } from '@igility/greenroom-shared';

/**
 * Deleting a commented item, when the story around it survives.
 *
 * This is the failure the story-level gate is structurally unable to see. On the project
 * this was built for, 35 decision cards live in three stories: remove one and no story id
 * changes, the delta is empty, the upload sails through, and a client comment quietly
 * stops resolving. Nothing anywhere reports it.
 *
 * The story-level rules are also the wrong way round for this workflow. A card RENAMED
 * and MOVED to reflect its new status is the ordinary act of running a review and must
 * pass without comment; a card DELETED out from under an open comment is the one thing
 * that must not. A derived anchor gets both backwards — it breaks on the rename and is
 * blind to the deletion — which is why the anchor is declared and this check exists.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const admin: Principal = { kind: 'admin', id: 'a', name: 'Admin' };
const STORY = 'design-system-decisions--decisions';

/** One story holding many anchored cards — the real shape. */
const build = (anchors: string[], marker: string, withManifest = true) =>
  zipSync({
    'index.json': enc(
      JSON.stringify({
        v: 5,
        entries: {
          [STORY]: {
            type: 'story',
            title: 'Design system/Decisions',
            name: 'Decisions',
            importPath: './stories/library/Decisions.stories.tsx',
            tags: ['dev'],
          },
        },
      }),
    ),
    'iframe.html': enc(`<html>${marker}</html>`),
    ...(withManifest
      ? { [ANCHOR_MANIFEST_FILE]: enc(JSON.stringify({ anchors: { [STORY]: anchors } })) }
      : {}),
  });

const CARDS = ['decision-radius', 'decision-offer-timing', 'decision-gradient'];

let dataDir: string;
let store: Store;

const commentOn = (anchor: string, body: string) => {
  const b = store.latestBuild()!;
  return store.createThread(
    {
      storyId: STORY,
      buildId: b.id,
      body,
      pin: {
        selector: `[data-greenroom-anchor="${anchor}"]`,
        x: 1,
        y: 1,
        viewportWidth: 1440,
        viewportHeight: 900,
        viewportLabel: null,
      },
    },
    admin,
  );
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-anchor-'));
  store = new Store(openMemoryDb(), dataDir);
  store.ingestBuildZip(build(CARDS, 'v1'), { label: 'live' }, admin);
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('reading the anchor a pin is attached to', () => {
  it('finds it inside whatever path finder produced', () => {
    expect(anchorInSelector('[data-greenroom-anchor="decision-radius"]')).toBe('decision-radius');
    expect(anchorInSelector('section > [data-greenroom-anchor="a-b"] > .card')).toBe('a-b');
    expect(anchorInSelector('ol:nth-child(4) > li:nth-of-type(1)')).toBeNull();
    expect(anchorInSelector(null)).toBeNull();
  });
});

describe('the edit we must allow', () => {
  it('lets a card be reworded and moved, because a declared anchor does not track its words', () => {
    // The whole point. Running the review means revising what a card says and shifting it
    // as its status changes; the anchor set is identical, so nothing is disturbed.
    commentOn('decision-radius', 'make this smaller');
    const reordered = ['decision-gradient', 'decision-radius', 'decision-offer-timing'];
    const r = store.ingestBuildZip(build(reordered, 'v2-reworded'), { label: 'status' }, admin);
    expect(r.created).toBe(true);
    expect(r.delta!.droppedAnchors).toEqual([]);
    expect(r.delta!.concerns).toEqual([]);
  });
});

describe('the edit we must catch', () => {
  it('refuses to drop a card that carries an open comment, and says which comment', () => {
    commentOn('decision-radius', 'Reduce the radius on the primary button');
    let err: HttpError | undefined;
    try {
      store.ingestBuildZip(
        build(['decision-offer-timing', 'decision-gradient'], 'v2'),
        { label: 'deleted-a-card' },
        admin,
      );
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.status).toBe(409);
    expect(err?.message).toMatch(/1 anchored item is deleted while its story stays/);
    expect(err?.message).toMatch(/decision-radius/);
    const d = err?.details as { droppedAnchors: { anchor: string; sample: string }[] };
    // The words matter: "1 anchor dropped" tells nobody which objection is about to
    // vanish, and that is the fact the person deciding needs.
    expect(d.droppedAnchors[0]!.sample).toBe('Reduce the radius on the primary button');
  });

  it('stays silent about a card whose comments are all resolved', () => {
    const t = commentOn('decision-radius', 'done with this one');
    store.setThreadState(t.thread.id, 'resolved', admin);
    const r = store.ingestBuildZip(build(['decision-gradient'], 'v2'), { label: 'tidy' }, admin);
    expect(r.created).toBe(true);
    expect(r.delta!.droppedAnchors).toEqual([]);
  });

  it('says nothing about deleting a card nobody commented on', () => {
    commentOn('decision-radius', 'keep this');
    const r = store.ingestBuildZip(
      build(['decision-radius', 'decision-gradient'], 'v2'),
      { label: 'drop-uncommented' },
      admin,
    );
    expect(r.created).toBe(true);
    expect(r.delta!.droppedAnchors).toEqual([]);
  });

  it('goes through when the deletion is claimed by name', () => {
    commentOn('decision-radius', 'this one is settled, remove it');
    const r = store.ingestBuildZip(build(['decision-gradient'], 'v2'), {
      label: 'deliberate',
      allowRemoved: ['decision-radius'],
    }, admin);
    expect(r.created).toBe(true);
    expect(r.delta!.droppedAnchors).toHaveLength(1);
  });
});

describe('a host that ships no manifest', () => {
  it('keeps working, and simply does not run the check', () => {
    // Optional means optional. A hand-authored Storybook that emits nothing must behave
    // exactly as it did before this existed.
    commentOn('decision-radius', 'still here');
    const r = store.ingestBuildZip(build([], 'v2', false), { label: 'no-manifest' }, admin);
    expect(r.created).toBe(true);
    expect(r.delta!.droppedAnchors).toEqual([]);
  });

  it('treats a malformed manifest as absent rather than fatal', () => {
    // A broken manifest must never be able to block a deploy: the failure it causes is
    // worse than the check it disables.
    commentOn('decision-radius', 'still here');
    const broken = zipSync({
      'index.json': enc(
        JSON.stringify({
          v: 5,
          entries: {
            [STORY]: {
              type: 'story',
              title: 'Design system/Decisions',
              name: 'Decisions',
              importPath: './stories/library/Decisions.stories.tsx',
              tags: ['dev'],
            },
          },
        }),
      ),
      'iframe.html': enc('<html>v2</html>'),
      [ANCHOR_MANIFEST_FILE]: enc('{ not json at all'),
    });
    const r = store.ingestBuildZip(broken, { label: 'broken-manifest' }, admin);
    expect(r.created).toBe(true);
    expect(r.delta!.droppedAnchors).toEqual([]);
  });

  it('does not report anchors for a story the manifest says nothing about', () => {
    // Declaring nothing is not declaring emptiness. A host instrumenting one page at a
    // time must not have every anchor on every other page reported as dropped.
    commentOn('decision-radius', 'still here');
    const partial = zipSync({
      'index.json': enc(
        JSON.stringify({
          v: 5,
          entries: {
            [STORY]: {
              type: 'story',
              title: 'Design system/Decisions',
              name: 'Decisions',
              importPath: './stories/library/Decisions.stories.tsx',
              tags: ['dev'],
            },
          },
        }),
      ),
      'iframe.html': enc('<html>v2</html>'),
      [ANCHOR_MANIFEST_FILE]: enc(JSON.stringify({ anchors: { 'some-other-story': ['x'] } })),
    });
    const r = store.ingestBuildZip(partial, { label: 'partial' }, admin);
    expect(r.created).toBe(true);
    expect(r.delta!.droppedAnchors).toEqual([]);
  });
});
