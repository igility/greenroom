import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openMemoryDb } from '../src/db.js';
import { Store } from '../src/store.js';
import type { Config } from '../src/config.js';

const ADMIN = 'test-admin-key';
const enc = (s: string) => new TextEncoder().encode(s);

const storybookZip = (marker: string) =>
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
          'components-badge--success': {
            type: 'story',
            title: 'Components/Badge',
            name: 'Success',
            importPath: './src/Badge.stories.tsx',
          },
          'components-button--docs': { type: 'docs', title: 'Components/Button', name: 'Docs' },
        },
      }),
    ),
    'iframe.html': enc(`<html><body>${marker}</body></html>`),
  });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-test-'));
const config: Config = {
  dataDir,
  port: 0,
  publicUrl: 'http://greenroom.test',
  adminKey: ADMIN,
  adminKeyGenerated: false,
  shellDir: path.join(process.cwd(), 'shell'),
};
const store = new Store(openMemoryDb(), dataDir);
const app = createApp(store, config);

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const asAdmin = { authorization: `Bearer ${ADMIN}` };
const json = { 'content-type': 'application/json' };

describe('review cycle end to end', () => {
  let buildA: string;
  let buildB: string;
  let reviewerCookie: string;
  let agentToken: string;
  let threadId: string;

  it('rejects unauthenticated API access', async () => {
    const res = await app.request('/api/stories');
    expect(res.status).toBe(401);
  });

  it('ingests build A and creates stories in review', async () => {
    const res = await app.request('/api/builds?label=design-v1&gitSha=abc123', {
      method: 'POST',
      headers: { ...asAdmin, 'content-type': 'application/zip' },
      body: storybookZip('build-a'),
    });
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out.created).toBe(true);
    expect(out.newStories).toBe(2);
    buildA = out.build.id;

    const stories = await (await app.request('/api/stories', { headers: asAdmin })).json();
    expect(stories.stories).toHaveLength(2);
    expect(stories.stories.every((s: { state: string }) => s.state === 'in_review')).toBe(true);
  });

  it('redeems a magic link into a reviewer session', async () => {
    const reviewer = await (
      await app.request('/api/reviewers', {
        method: 'POST',
        headers: { ...asAdmin, ...json },
        body: JSON.stringify({ name: 'Jordan Client', email: 'jordan@example.com' }),
      })
    ).json();
    const link = await (
      await app.request(`/api/reviewers/${reviewer.reviewer.id}/links`, {
        method: 'POST',
        headers: asAdmin,
      })
    ).json();
    expect(link.url).toContain('http://greenroom.test/review/');

    const redeem = await app.request(`/review/${link.token}`);
    expect(redeem.status).toBe(302);
    const setCookie = redeem.headers.get('set-cookie')!;
    expect(setCookie).toContain('gr_session=');
    reviewerCookie = setCookie.split(';')[0]!;

    const me = await (
      await app.request('/api/me', { headers: { cookie: reviewerCookie } })
    ).json();
    expect(me.principal.kind).toBe('reviewer');
    expect(me.principal.name).toBe('Jordan Client');
  });

  it('lets the reviewer drop a pinned comment thread', async () => {
    const res = await app.request('/api/threads', {
      method: 'POST',
      headers: { cookie: reviewerCookie, ...json },
      body: JSON.stringify({
        storyId: 'components-button--primary',
        buildId: buildA,
        body: 'The label wraps on small screens — can it stay on one line?',
        pin: { selector: 'button.demo-button', x: 0.5, y: 0.4, viewportWidth: 1280, viewportHeight: 720 },
        args: { label: 'Save changes', variant: 'primary' },
      }),
    });
    expect(res.status).toBe(201);
    const out = await res.json();
    threadId = out.feedback.thread.id;
    expect(out.feedback.story.importPath).toBe('./src/Button.stories.tsx');
    expect(out.feedback.messages).toHaveLength(1);
  });

  it('gives an agent the open feedback with full context, replies as agent_note', async () => {
    const minted = await (
      await app.request('/api/tokens', {
        method: 'POST',
        headers: { ...asAdmin, ...json },
        body: JSON.stringify({ kind: 'agent', name: 'Claude' }),
      })
    ).json();
    agentToken = minted.token;

    const feedback = await (
      await app.request('/api/feedback?state=open', {
        headers: { authorization: `Bearer ${agentToken}` },
      })
    ).json();
    expect(feedback.feedback).toHaveLength(1);
    expect(feedback.feedback[0].thread.pin.selector).toBe('button.demo-button');

    const reply = await (
      await app.request(`/api/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${agentToken}`, ...json },
        body: JSON.stringify({ body: 'Set white-space: nowrap on the label. Pushing a fix.' }),
      })
    ).json();
    expect(reply.message.kind).toBe('agent_note');
  });

  it('refuses approval while a comment on the story is unresolved', async () => {
    // An unresolved thread is an objection nobody has answered. Approving over it would
    // write a green sign-off with an open complaint still attached, and the audit trail
    // would say approved while the review said otherwise.
    const refused = await app.request('/api/stories/components-button--primary/status', {
      method: 'POST',
      headers: { cookie: reviewerCookie, ...json },
      body: JSON.stringify({ to: 'approved', buildId: buildA }),
    });
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body.reason).toBe('OPEN_THREADS');
    expect(body.error).toMatch(/unresolved comment/);

    // Still in review — a refused approval must not half-apply.
    const after = await (
      await app.request('/api/stories/components-button--primary', {
        headers: { cookie: reviewerCookie },
      })
    ).json();
    expect(after.story.state).not.toBe('approved');
  });

  it('walks changes_requested → addressed → approved', async () => {
    const cr = await app.request('/api/stories/components-button--primary/status', {
      method: 'POST',
      headers: { cookie: reviewerCookie, ...json },
      body: JSON.stringify({ to: 'changes_requested', buildId: buildA }),
    });
    expect(cr.status).toBe(200);

    const addressed = await app.request('/api/stories/components-button--primary/status', {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}`, ...json },
      body: JSON.stringify({ to: 'addressed', note: 'Fix pushed in latest build.' }),
    });
    expect(addressed.status).toBe(200);

    // Accepting the fix is an explicit act: the reviewer resolves the thread they raised,
    // and only then can the story be signed off.
    const resolved = await app.request(`/api/threads/${threadId}/state`, {
      method: 'POST',
      headers: { cookie: reviewerCookie, ...json },
      body: JSON.stringify({ state: 'resolved' }),
    });
    expect(resolved.status).toBe(200);

    for (const storyId of ['components-button--primary', 'components-badge--success']) {
      const approve = await app.request(`/api/stories/${storyId}/status`, {
        method: 'POST',
        headers: { cookie: reviewerCookie, ...json },
        body: JSON.stringify({ to: 'approved', buildId: buildA }),
      });
      expect(approve.status).toBe(200);
      const { story } = await approve.json();
      expect(story.state).toBe('approved');
      expect(story.anchorBuildId).toBe(buildA);
    }
  });

  it('accepts build B without disturbing anybody’s approvals', async () => {
    const res = await app.request('/api/builds?label=design-v2', {
      method: 'POST',
      headers: { ...asAdmin, 'content-type': 'application/zip' },
      body: storybookZip('build-b'),
    });
    const out = await res.json();
    expect(out.created).toBe(true);
    // Uploading is not evidence about any component. Nothing is unsettled until a
    // render actually shows a difference — and the upload result no longer even carries
    // a re-confirmation count, because there is no longer anything that could raise it.
    expect(out).not.toHaveProperty('reconfirmed');
    buildB = out.build.id;

    const still = await (
      await app.request('/api/stories/components-button--primary', {
        headers: { cookie: reviewerCookie },
      })
    ).json();
    expect(still.story.state).toBe('approved');
  });

  it('keeps every approval and reports which component changed', async () => {
    const put = (storyId: string, buildId: string, hash: string) =>
      app.request('/api/fingerprints', {
        method: 'PUT',
        headers: { cookie: reviewerCookie, ...json },
        body: JSON.stringify({ storyId, buildId, hash: hash.repeat(8) }),
      });
    await put('components-button--primary', buildA, 'aaaaaaaa');
    await put('components-button--primary', buildB, 'aaaaaaaa'); // unchanged
    await put('components-badge--success', buildA, 'bbbbbbbb');
    await put('components-badge--success', buildB, 'cccccccc'); // changed

    const stories = await (await app.request('/api/stories', { headers: asAdmin })).json();
    const byId = Object.fromEntries(
      stories.stories.map((x: { storyId: string }) => [x.storyId, x]),
    );

    // Nothing is withdrawn. A render moving is reported, not punished.
    expect(byId['components-button--primary'].state).toBe('approved');
    expect(byId['components-button--primary'].changedSinceApproval).toBe(false);
    expect(byId['components-badge--success'].state).toBe('approved');
    expect(byId['components-badge--success'].changedSinceApproval).toBe(true);
  });

  it('reopens a story so the agent-approval rules have something to act on', async () => {
    const res = await app.request('/api/stories/components-badge--success/status', {
      method: 'POST',
      headers: { cookie: reviewerCookie, ...json },
      body: JSON.stringify({ to: 'in_review' }),
    });
    expect(res.status).toBe(200);
  });

  it('blocks agent approval without a delegation, with the warning', async () => {
    // Uses the story that genuinely changed, since the unchanged one has been handed
    // back to approved and is no longer awaiting anybody's decision.
    const res = await app.request('/api/stories/components-badge--success/status', {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}`, ...json },
      body: JSON.stringify({ to: 'approved', buildId: buildB }),
    });
    expect(res.status).toBe(403);
    const out = await res.json();
    expect(out.reason).toBe('AGENT_APPROVAL_DISABLED');
    expect(out.error).toMatch(/written client authorization/);
  });

  it('allows agent approval under a recorded delegation, audit-labeled delegated', async () => {
    // The story that genuinely changed: the unchanged one carried its approval forward
    // and is no longer anybody's to decide.
    await app.request('/api/delegations', {
      method: 'POST',
      headers: { ...asAdmin, ...json },
      body: JSON.stringify({
        authorizationNote: 'Client email 2026-08-12: batch-approve remaining screens for launch.',
      }),
    });

    const res = await app.request('/api/stories/components-badge--success/status', {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}`, ...json },
      body: JSON.stringify({ to: 'approved', buildId: buildB }),
    });
    expect(res.status).toBe(200);
    const { story } = await res.json();
    expect(story.state).toBe('approved');
    expect(story.anchorBuildId).toBe(buildB);

    const audit = await (await app.request('/api/audit/export', { headers: asAdmin })).json();
    const delegated = audit.statusEvents.find(
      (e: { approvalMode: string | null }) => e.approvalMode === 'delegated',
    );
    expect(delegated).toBeTruthy();
    expect(delegated.principal.kind).toBe('agent');
    expect(delegated.delegationId).toBeTruthy();
    const direct = audit.statusEvents.filter(
      (e: { approvalMode: string | null }) => e.approvalMode === 'direct',
    );
    expect(direct.length).toBeGreaterThan(0);
  });

  it('dedupes an identical re-upload without touching state', async () => {
    const res = await app.request('/api/builds?label=design-v2-again', {
      method: 'POST',
      headers: { ...asAdmin, 'content-type': 'application/zip' },
      body: storybookZip('build-b'),
    });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.created).toBe(false);
    expect(out).not.toHaveProperty('reconfirmed');
  });

  it('serves the newest build at the root to an authenticated principal', async () => {
    const res = await app.request('/iframe.html', {
      headers: { cookie: reviewerCookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    // buildB is newest at this point in the cycle — the root always serves newest.
    expect(await res.text()).toContain('build-b');
    // The old pinned address is not gone silently: it heals the visitor.
    const pinned = await app.request(`/builds/${buildA}/iframe.html`, {
      headers: { cookie: reviewerCookie },
    });
    expect(pinned.status).toBe(308);
    expect(pinned.headers.get('location')).toBe('/iframe.html');
  });

  it('keeps identity endpoints off-limits without a session', async () => {
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
  });

  it('serves the reviewer shell page', async () => {
    const res = await app.request('/review/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Greenroom');
  });
});
