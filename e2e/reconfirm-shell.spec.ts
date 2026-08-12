import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

const ROOT = process.cwd();
const ADMIN = 'reconfirm-admin';
const SIDECAR = 'http://localhost:4803';
const DATA_DIR = path.join(ROOT, 'e2e/.artifacts/reconfirm-data');
const STORYBOOK_STATIC = path.join(ROOT, 'examples/demo-storybook/storybook-static');

let sidecar: ChildProcess;
let magicLinkUrl: string;
let buildA: string;
let buildB: string;

const adminFetch = (p: string, init?: RequestInit) =>
  fetch(`${SIDECAR}${p}`, {
    ...init,
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

async function waitFor(url: string, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const upload = (dir: string, label: string) => {
  const r = spawnSync('node', ['packages/server/dist/cli.js', 'upload', dir, '--url', SIDECAR, '--token', ADMIN, '--label', label], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
};

const putFingerprint = (storyId: string, buildId: string, hash: string) =>
  adminFetch('/api/fingerprints', { method: 'PUT', body: JSON.stringify({ storyId, buildId, hash: hash.repeat(8) }) });

test.beforeAll(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  sidecar = spawn('node', ['packages/server/dist/cli.js', 'serve'], {
    cwd: ROOT,
    env: { ...process.env, GREENROOM_ADMIN_KEY: ADMIN, GREENROOM_DATA_DIR: DATA_DIR, GREENROOM_PORT: '4803' },
    stdio: 'inherit',
  });
  await waitFor(`${SIDECAR}/api/health`);

  // Build A, approve everything, then a distinct Build B (changed iframe → new
  // manifest hash) that flips every approval to needs_reconfirm.
  upload(STORYBOOK_STATIC, 'design-A');
  buildA = (await (await adminFetch('/api/builds/latest')).json()).build.id;
  const stories = (await (await adminFetch('/api/stories')).json()).stories as { storyId: string }[];
  for (const s of stories) {
    await adminFetch(`/api/stories/${encodeURIComponent(s.storyId)}/status`, {
      method: 'POST',
      body: JSON.stringify({ to: 'approved', buildId: buildA }),
    });
  }

  const bDir = path.join(DATA_DIR, 'sb-B');
  fs.cpSync(STORYBOOK_STATIC, bDir, { recursive: true });
  fs.appendFileSync(path.join(bDir, 'iframe.html'), '\n<!-- build B -->\n');
  upload(bDir, 'design-B');
  buildB = (await (await adminFetch('/api/builds/latest')).json()).build.id;

  // One story changed between A and B; the rest unchanged. The shell sorts the
  // queue by this verdict.
  const changed = 'components-button--primary';
  await putFingerprint(changed, buildA, 'aaaaaaaa');
  await putFingerprint(changed, buildB, 'bbbbbbbb');
  for (const s of stories) {
    if (s.storyId === changed) continue;
    await putFingerprint(s.storyId, buildA, 'cccccccc');
    await putFingerprint(s.storyId, buildB, 'cccccccc');
  }

  const reviewer = await (
    await adminFetch('/api/reviewers', { method: 'POST', body: JSON.stringify({ name: 'Jordan Client', email: 'jordan@example.com' }) })
  ).json();
  const link = await (await adminFetch(`/api/reviewers/${reviewer.reviewer.id}/links`, { method: 'POST' })).json();
  magicLinkUrl = link.url.replace('http://localhost:4803', SIDECAR);
});

test.afterAll(() => sidecar?.kill());

test('new build flips approvals to needs_reconfirm, queue sorted changed-first', async ({ page }) => {
  await page.goto(magicLinkUrl);

  // Every previously-approved story is back in the reviewer's re-confirm queue.
  await expect(page.getByRole('heading', { name: 'Needs re-confirmation (17)' })).toBeVisible();

  // The changed story is flagged "changed" and sorts to the top of that group.
  const rows = page.locator('#story-list .story');
  const firstUnderReconfirm = page.locator('nav h2', { hasText: 'Needs re-confirmation' }).locator('~ .story').first();
  await expect(firstUnderReconfirm.locator('.verdict.changed')).toHaveText('changed');
  await expect(page.locator('.verdict.likely_unchanged').first()).toHaveText('likely unchanged');

  await page.screenshot({ path: 'e2e/.artifacts/reconfirm-queue.png', fullPage: true });

  // Re-confirm the changed story against build B — this is the reviewer's queue,
  // distinct from an agent's changes-requested queue.
  await firstUnderReconfirm.click();
  await page.locator('#rail').getByRole('button', { name: 'Approve again' }).click();
  await expect(page.getByRole('heading', { name: 'Needs re-confirmation (16)' })).toBeVisible();

  const story = await (await adminFetch('/api/stories/components-button--primary')).json();
  expect(story.story.state).toBe('approved');
  expect(story.story.anchorBuildId).toBe(buildB);

  // Every event is in the exportable audit trail.
  const audit = await (await adminFetch('/api/audit/export')).json();
  const reconfirmEvents = audit.statusEvents.filter((e: { to: string }) => e.to === 'needs_reconfirm');
  expect(reconfirmEvents.length).toBe(17);
  void rows;
});
