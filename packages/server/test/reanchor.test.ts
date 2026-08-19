import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../src/db.js';
import { Store } from '../src/store.js';
import type { Principal } from '@igility/greenroom-shared';

/**
 * Re-pointing a comment at a stable anchor.
 *
 * Comments on a list of cards get positional selectors, because markup with no ids,
 * classes or roles gives `finder` nothing else to build from. Reorder the list and the
 * selector resolves to a DIFFERENT card — the comment is not lost, it is mis-pointed,
 * which is worse because "show me" scrolls to the wrong thing while the screenshot
 * still shows the right one.
 *
 * The rewrite is decided in a browser and sent here. These defend the part that has to
 * be true regardless of what the browser concluded: the original is never lost.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const admin: Principal = { kind: 'admin', id: 'a', name: 'Admin' };
const STORY = 'design-system-decisions--decisions';
const POSITIONAL = 'ol:nth-child(4) > li:nth-of-type(8) > .flex > div';
const STABLE = '[data-greenroom-anchor="the-icon-set"]';

const zip = () =>
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
          },
        },
      }),
    ),
    'iframe.html': enc('<html></html>'),
  });

let dataDir: string;
let store: Store;
let threadId: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-reanchor-'));
  store = new Store(openMemoryDb(), dataDir);
  const buildId = store.ingestBuildZip(zip(), { label: 'v1' }, admin).build.id;
  threadId = store.createThread(
    {
      storyId: STORY,
      buildId,
      body: 'Agreed, we will not have reviews at launch.',
      pin: {
        selector: POSITIONAL,
        x: 0.5,
        y: 0.4,
        viewportWidth: 1440,
        viewportHeight: 900,
        viewportLabel: null,
      },
    },
    admin,
  ).thread.id;
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('re-anchoring a comment', () => {
  it('moves the pin and keeps where it started', () => {
    const t = store.reanchorThread(threadId, STABLE);
    expect(t.pin?.selector).toBe(STABLE);
    expect(t.pin?.selectorOriginal).toBe(POSITIONAL);
  });

  it('keeps the FIRST original when re-anchored twice', () => {
    // The reviewer pinned it at the positional selector. A second pass must not
    // overwrite that with the first pass's output, or the only record of where the
    // comment actually started is quietly replaced by a machine's guess about it.
    store.reanchorThread(threadId, STABLE);
    store.reanchorThread(threadId, '[data-greenroom-anchor="something-else"]');
    expect(store.getFeedbackItem(threadId).thread.pin?.selectorOriginal).toBe(POSITIONAL);
  });

  it('is a no-op when the selector already matches', () => {
    store.reanchorThread(threadId, POSITIONAL);
    // Nothing moved, so nothing was overwritten — `selectorOriginal` stays null rather
    // than recording a move that did not happen.
    expect(store.getFeedbackItem(threadId).thread.pin?.selectorOriginal).toBeNull();
  });

  it('puts a comment back where it was pinned', () => {
    store.reanchorThread(threadId, STABLE);
    const t = store.restoreThreadAnchor(threadId);
    expect(t.pin?.selector).toBe(POSITIONAL);
    expect(t.pin?.selectorOriginal).toBeNull();
    // And restoring twice is harmless rather than destructive.
    expect(store.restoreThreadAnchor(threadId).pin?.selector).toBe(POSITIONAL);
  });

  it('refuses a comment that was never pinned', () => {
    const buildId = store.latestBuild()!.id;
    const general = store.createThread(
      { storyId: STORY, buildId, body: 'A general remark.' },
      admin,
    ).thread.id;
    expect(() => store.reanchorThread(general, STABLE)).toThrowError(/nothing to re-anchor/i);
  });

  it('never touches the comment itself', () => {
    // The whole point. Re-anchoring moves a pointer; it must not disturb what was said,
    // who said it, when, or the screenshot that proves what they were looking at.
    const before = store.getFeedbackItem(threadId);
    store.reanchorThread(threadId, STABLE);
    const after = store.getFeedbackItem(threadId);
    expect(after.messages).toEqual(before.messages);
    expect(after.thread.createdAt).toBe(before.thread.createdAt);
    expect(after.thread.createdBy).toEqual(before.thread.createdBy);
    expect(after.thread.screenshotAttachmentId).toBe(before.thread.screenshotAttachmentId);
    expect(after.thread.state).toBe(before.thread.state);
  });
});
