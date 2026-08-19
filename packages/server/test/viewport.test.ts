import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../src/db.js';
import { Store } from '../src/store.js';
import type { Principal } from '@igility/greenroom-shared';

/**
 * Which viewport a comment was left in.
 *
 * A thread always recorded the pixel width of the preview, which is a fact but not the
 * one anybody asks. "Is this broken on mobile" is answered by what the reviewer chose,
 * and a width alone cannot tell a deliberate 390px preset from a narrow window with the
 * panel docked. It matters most to whoever fixes the comment: a defect reported at
 * mobile width may not reproduce at desktop width at all.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const admin: Principal = { kind: 'admin', id: 'a', name: 'Admin' };
const STORY = 'components-button--primary';

const zip = () =>
  zipSync({
    'index.json': enc(
      JSON.stringify({
        v: 5,
        entries: {
          [STORY]: {
            type: 'story',
            title: 'Components/Button',
            name: 'Primary',
            importPath: './src/Button.stories.tsx',
          },
        },
      }),
    ),
    'iframe.html': enc('<html></html>'),
  });

let dataDir: string;
let db: ReturnType<typeof openMemoryDb>;
let store: Store;
let buildId: string;

const pin = (over: Record<string, unknown> = {}) => ({
  selector: 'button.demo',
  x: 0.5,
  y: 0.4,
  viewportWidth: 390,
  viewportHeight: 844,
  viewportLabel: 'mobile',
  ...over,
});

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-viewport-'));
  db = openMemoryDb();
  store = new Store(db, dataDir);
  buildId = store.ingestBuildZip(zip(), { label: 'v1' }, admin).build.id;
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('the viewport a comment was written in', () => {
  it('records the viewport the reviewer selected', () => {
    const fb = store.createThread(
      { storyId: STORY, buildId, body: 'The label wraps here.', pin: pin() },
      admin,
    );
    expect(fb.thread.pin?.viewportLabel).toBe('mobile');
    // The width travels with it. Reproducing the defect needs the number, not the name.
    expect(fb.thread.pin?.viewportWidth).toBe(390);
  });

  it('survives a round trip through the store', () => {
    const id = store.createThread(
      { storyId: STORY, buildId, body: 'x', pin: pin({ viewportLabel: 'tablet' }) },
      admin,
    ).thread.id;
    expect(store.getFeedbackItem(id).thread.pin?.viewportLabel).toBe('tablet');
  });

  it('is null when the reviewer selected no viewport, rather than guessed from width', () => {
    // 1440px is not a claim that anybody chose "desktop". Labelling it would invent the
    // reviewer's intent, and the whole value of the field is that it reports intent.
    const fb = store.createThread(
      {
        storyId: STORY,
        buildId,
        body: 'x',
        pin: pin({ viewportWidth: 1440, viewportHeight: 900, viewportLabel: null }),
      },
      admin,
    );
    expect(fb.thread.pin?.viewportLabel).toBeNull();
    expect(fb.thread.pin?.viewportWidth).toBe(1440);
  });

  it('is null for a comment with no pin at all', () => {
    const fb = store.createThread({ storyId: STORY, buildId, body: 'General remark.' }, admin);
    expect(fb.thread.pin).toBeNull();
  });

  it('reads null on threads written before the column existed', () => {
    // The migration adds a nullable column; every thread already in a client's store
    // keeps its width and gains no label, which is the truthful answer for a comment
    // made before anything recorded one.
    const id = store.createThread({ storyId: STORY, buildId, body: 'x', pin: pin() }, admin)
      .thread.id;
    db.prepare('UPDATE threads SET viewport_label = NULL WHERE id = ?').run(id);
    const thread = store.getFeedbackItem(id).thread;
    expect(thread.pin?.viewportLabel).toBeNull();
    expect(thread.pin?.viewportWidth).toBe(390);
  });
});
