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
          // A second, independent component. Batch approval is about applying one
          // review to OTHER components, so it cannot be shown with only one.
          'components-badge--success': {
            type: 'story',
            title: 'Components/Badge',
            name: 'Success',
            importPath: './src/Badge.stories.tsx',
          },
        },
      }),
    ),
    'iframe.html': enc(`<html>${marker}</html>`),
    'assets/app.js': enc(`console.log(${JSON.stringify(marker)})`),
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

  it('re-confirms an approval whose render has moved, advancing the anchor', () => {
    const STORY = 'components-button--primary';
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, adminP);
    store.setStoryState(STORY, 'approved', adminP, { buildId: a.build.id });
    store.putRenderReport(STORY, a.build.id, { hash: 'as-approved' });

    const b = store.ingestBuildZip(zip('b'), { label: 'v2' }, adminP);
    store.putRenderReport(STORY, b.build.id, { hash: 'restyled' });
    expect(store.changedSinceApproval(store.getStory(STORY))).toBe(true);

    // The act the reviewer performs on a flagged component. Before approved → approved
    // existed it was refused outright, so the flag could never be cleared and the
    // Approve button did nothing at all.
    store.setStoryState(STORY, 'approved', adminP, { buildId: b.build.id });

    const after = store.getStory(STORY);
    expect(after.state).toBe('approved');
    expect(after.anchorBuildId).toBe(b.build.id);
    expect(store.changedSinceApproval(after)).toBe(false);
    // The re-look is its own entry in the trail, not a silent anchor move.
    const events = store.listEvents(STORY).filter((e) => e.to === 'approved');
    expect(events).toHaveLength(2);
    expect(events[1]!.buildId).toBe(b.build.id);
  });

  it('refuses a re-approval when nothing has changed (409 NOTHING_CHANGED)', () => {
    const STORY = 'components-button--primary';
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, adminP);
    store.setStoryState(STORY, 'approved', adminP, { buildId: a.build.id });
    // Otherwise a client could write unlimited identical sign-offs into an append-only
    // trail, each indistinguishable from a genuine re-look.
    expect(() =>
      store.setStoryState(STORY, 'approved', adminP, { buildId: a.build.id }),
    ).toThrowError(/already approved and has not changed/i);
    expect(store.listEvents(STORY).filter((e) => e.to === 'approved')).toHaveLength(1);
  });

  it('batch-approves the other changed components, recorded as batch and not as a look', () => {
    const A = 'components-button--primary';
    const B = 'components-badge--success';
    const one = store.ingestBuildZip(zip('a'), { label: 'v1' }, adminP);
    for (const s of [A, B]) {
      store.setStoryState(s, 'approved', adminP, { buildId: one.build.id });
      store.putRenderReport(s, one.build.id, { hash: `as-approved-${s}` });
    }
    const two = store.ingestBuildZip(zip('b'), { label: 'v2' }, adminP);
    for (const s of [A, B]) store.putRenderReport(s, two.build.id, { hash: `moved-${s}` });

    // The reviewer opens A. B is offered because it also moved in this build — the
    // offer is drawn from the flag, never from a claim that A caused B.
    const offered = store.alsoChanged(A).map((s) => s.storyId);
    expect(offered).toEqual([B]);

    store.setStoryState(A, 'approved', adminP, { buildId: two.build.id });
    const result = store.batchApprove([B], adminP, {
      buildId: two.build.id,
      becauseOf: A,
    });
    expect(result.approved).toEqual([B]);
    expect(result.skipped).toEqual([]);
    expect(store.changedSinceApproval(store.getStory(B))).toBe(false);

    const a = store.listEvents(A).filter((e) => e.to === 'approved').at(-1)!;
    const b = store.listEvents(B).filter((e) => e.to === 'approved').at(-1)!;
    // The trail has to be able to tell the component that was opened from the one
    // that was not, or an export overstates what a person actually examined.
    expect(a.approvalMode).toBe('direct');
    expect(b.approvalMode).toBe('batch');
    expect(b.note).toContain('not individually inspected');
    expect(b.note).toContain('Components/Button');
    // No causal claim anywhere in it.
    expect(b.note).not.toMatch(/because of|caused|due to/i);
  });

  it('a batch skips the members it cannot approve instead of failing the run', () => {
    const A = 'components-button--primary';
    const B = 'components-badge--success';
    const one = store.ingestBuildZip(zip('a'), { label: 'v1' }, adminP);
    for (const s of [A, B]) {
      store.setStoryState(s, 'approved', adminP, { buildId: one.build.id });
      store.putRenderReport(s, one.build.id, { hash: `as-approved-${s}` });
    }
    const two = store.ingestBuildZip(zip('b'), { label: 'v2' }, adminP);
    for (const s of [A, B]) store.putRenderReport(s, two.build.id, { hash: `moved-${s}` });
    // An objection raised on B after the offer was drawn.
    store.createThread({ storyId: B, buildId: two.build.id, body: 'the green is off' }, adminP);

    store.setStoryState(A, 'approved', adminP, { buildId: two.build.id });
    const result = store.batchApprove([B], adminP, { buildId: two.build.id, becauseOf: A });

    expect(result.approved).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('OPEN_THREADS');
    // Skipped means untouched, not quietly approved.
    expect(store.changedSinceApproval(store.getStory(B))).toBe(true);
  });

  it('refuses a batch approval from an agent even under a delegation', () => {
    const A = 'components-button--primary';
    const B = 'components-badge--success';
    const one = store.ingestBuildZip(zip('a'), { label: 'v1' }, adminP);
    for (const s of [A, B]) {
      store.setStoryState(s, 'approved', adminP, { buildId: one.build.id });
      store.putRenderReport(s, one.build.id, { hash: `as-approved-${s}` });
    }
    const two = store.ingestBuildZip(zip('b'), { label: 'v2' }, adminP);
    for (const s of [A, B]) store.putRenderReport(s, two.build.id, { hash: `moved-${s}` });
    store.createDelegation('Client email: approve the remaining screens.', adminP);

    const agent: Principal = { kind: 'agent', id: 'ag-1', name: 'Claude' };
    // A delegation authorizes an agent to approve; it does not authorize it to approve
    // things nobody named. Batch is a human shorthand for "and the rest of these".
    const result = store.batchApprove([B], agent, { buildId: two.build.id, becauseOf: A });
    expect(result.approved).toEqual([]);
    expect(result.skipped[0]!.reason).toBe('AGENT_BATCH_FORBIDDEN');
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

  it('orders two builds uploaded in the same millisecond by arrival', () => {
    // created_at is millisecond ISO, so a scripted double upload can tie. Ordering by it
    // alone let SQLite hand back the OLDER build as "latest", which silently switched off
    // changedSinceApproval, pinned approvals to a superseded build, and could land a
    // reviewer on it from a magic link.
    const db = openMemoryDb();
    const s = new Store(db, dataDir);
    const first = s.ingestBuildZip(zip('one'), { label: 'v1' }, adminP).build;
    const second = s.ingestBuildZip(zip('two'), { label: 'v2' }, adminP).build;

    // Force the tie rather than racing for it. Two ingests usually land in the same
    // millisecond but not always, and a test that only sometimes reproduces the
    // condition it names is a test that will pass while the bug is back.
    db.prepare('UPDATE builds SET created_at = ?').run(first.createdAt);
    expect(s.getBuild(second.id).createdAt).toBe(s.getBuild(first.id).createdAt);

    expect(s.latestBuild()!.id).toBe(second.id);
    expect(s.listBuilds()[0]!.id).toBe(second.id);
  });

  it('sets a strict CSP and no unsafe-inline script on the shell page', async () => {
    const res = await app.request('/review/');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
  });
  /**
   * Greenroom is meant to sit behind a CDN. Until these headers existed it sent no cache
   * directive at all, so whether a client's data got cached was decided entirely by CDN
   * configuration this service never sees.
   */
  it('forbids any cache from storing an API response', async () => {
    const res = await app.request('/api/health');
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Belt and braces for an intermediary that ignores no-store: the answer depends on
    // who asked, and /api/stories is the same URL for every reviewer.
    expect(res.headers.get('vary')).toMatch(/Authorization/);
  });

  it('applies no-store to an authenticated API response too, not just health', async () => {
    store.ingestBuildZip(zip('a'), { label: 'v1' }, adminP);
    const res = await app.request('/api/stories', { headers: asAdmin });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('lets a browser cache build assets, but never a shared cache — and never the html', async () => {
    const build = store.ingestBuildZip(zip('a'), { label: 'v1' }, adminP);
    // `private`, because these are a client's unreleased design system behind a login.
    // A shared cache holding them would serve them from an edge where the authorization
    // check no longer runs.
    const asset = await app.request(`/builds/${build.build.id}/assets/app.js`, {
      headers: asAdmin,
    });
    expect(asset.status).toBe(200);
    const cc = asset.headers.get('cache-control') ?? '';
    expect(cc).toContain('private');
    expect(cc).not.toContain('public');
    expect(cc).toContain('immutable');
    // The html is the one file that is NOT immutable: the stale-build banner is injected
    // at serve time, so a cached copy suppresses the exact signal a returning reviewer
    // needs. This test used to assert `immutable` on iframe.html, and that assertion was
    // the bug — it happened to a real client.
    const html = await app.request(`/builds/${build.build.id}/iframe.html`, {
      headers: asAdmin,
    });
    expect(html.headers.get('cache-control')).toBe('no-store');
  });
});
