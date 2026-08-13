import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openMemoryDb } from '../src/db.js';
import { Store } from '../src/store.js';
import type { Config } from '../src/config.js';
import type { Principal } from '@igility/greenroom-shared';

const ADMIN = 'guard-admin';
const enc = (s: string) => new TextEncoder().encode(s);
const json = { 'content-type': 'application/json' };

const zip = (marker: string) =>
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
          },
        },
      }),
    ),
    'iframe.html': enc(`<html>${marker}</html>`),
  });

let dataDir: string;
let store: Store;
let app: ReturnType<typeof createApp>;

const adminP: Principal = { kind: 'admin', id: 'a', name: 'Admin' };

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-guard-'));
  store = new Store(openMemoryDb(), dataDir);
  const config: Config = {
    dataDir,
    port: 0,
    publicUrl: 'http://greenroom.test',
    adminKey: ADMIN,
    adminKeyGenerated: false,
    shellDir: path.join(process.cwd(), 'shell'),
  };
  app = createApp(store, config);
});

afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const asAdmin = { authorization: `Bearer ${ADMIN}` };

describe('approval guardrails', () => {
  it('rejects approval pinned to a superseded build (409 STALE_BUILD)', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, adminP);
    store.ingestBuildZip(zip('b'), { label: 'v2' }, adminP);
    // Story's lastSeenBuildId is now build B; approving against A must fail.
    expect(() =>
      store.setStoryState('components-button--primary', 'approved', adminP, { buildId: a.build.id }),
    ).toThrowError(/newer build/i);
  });

  it('rejects a status transition with a non-existent build id', () => {
    store.ingestBuildZip(zip('a'), { label: 'v1' }, adminP);
    expect(() =>
      store.setStoryState('components-button--primary', 'changes_requested', adminP, {
        buildId: 'no-such-build',
      }),
    ).toThrowError(/not found/i);
  });

  it('forbids a comment-only reviewer from approving', () => {
    const build = store.ingestBuildZip(zip('a'), { label: 'v1' }, adminP);
    const commenter: Principal = { kind: 'reviewer', id: 'r1', name: 'Sam', role: 'reviewer' };
    expect(() =>
      store.setStoryState('components-button--primary', 'approved', commenter, {
        buildId: build.build.id,
      }),
    ).toThrowError(/not authorized to approve/i);
    // …but can still request changes.
    const story = store.setStoryState('components-button--primary', 'changes_requested', commenter, {
      buildId: build.build.id,
    });
    expect(story.state).toBe('changes_requested');
  });

  it('lets an approver-role reviewer approve', () => {
    const build = store.ingestBuildZip(zip('a'), { label: 'v1' }, adminP);
    const approver: Principal = { kind: 'reviewer', id: 'r2', name: 'Dana', role: 'approver' };
    const story = store.setStoryState('components-button--primary', 'approved', approver, {
      buildId: build.build.id,
    });
    expect(story.state).toBe('approved');
  });
});

describe('input guardrails', () => {
  it('rejects a thread referencing a non-existent screenshot attachment', async () => {
    const build = store.ingestBuildZip(zip('a'), { label: 'v1' }, adminP);
    const res = await app.request('/api/threads', {
      method: 'POST',
      headers: { ...asAdmin, ...json },
      body: JSON.stringify({
        storyId: 'components-button--primary',
        buildId: build.build.id,
        body: 'x',
        screenshotAttachmentId: 'x" onerror="alert(1)',
      }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a zip archive with too many entries', () => {
    const entries: Record<string, Uint8Array> = { 'index.json': enc('{"entries":{}}') };
    for (let i = 0; i < 60_000; i++) entries[`f${i}.txt`] = enc('.');
    expect(() => store.ingestBuildZip(zipSync(entries), { label: 'bomb' }, adminP)).toThrowError(
      /too many files/i,
    );
  });

  it('sets a strict CSP and no unsafe-inline script on the shell page', async () => {
    const res = await app.request('/review/');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
  });
});
