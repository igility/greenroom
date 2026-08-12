import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

const ROOT = process.cwd();
const ADMIN = 'e2e-admin-key';
const SIDECAR = 'http://localhost:4802';
const DATA_DIR = path.join(ROOT, 'e2e/.artifacts/shell-data');
const STORYBOOK_STATIC = path.join(ROOT, 'examples/demo-storybook/storybook-static');

let sidecar: ChildProcess;
let magicLinkUrl: string;
let buildId: string;

const adminFetch = (p: string, init?: RequestInit) =>
  fetch(`${SIDECAR}${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

async function waitFor(url: string, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test.beforeAll(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  sidecar = spawn('node', ['packages/server/dist/cli.js', 'serve'], {
    cwd: ROOT,
    env: {
      ...process.env,
      GREENROOM_ADMIN_KEY: ADMIN,
      GREENROOM_DATA_DIR: DATA_DIR,
      GREENROOM_PORT: '4802',
    },
    stdio: 'inherit',
  });
  await waitFor(`${SIDECAR}/api/health`);

  const upload = spawnSync(
    'node',
    ['packages/server/dist/cli.js', 'upload', STORYBOOK_STATIC, '--url', SIDECAR, '--token', ADMIN, '--label', 'design-round-1'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(upload.status, upload.stderr).toBe(0);
  buildId = (await (await adminFetch('/api/builds/latest')).json()).build.id;

  const reviewer = await (
    await adminFetch('/api/reviewers', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jordan Client', email: 'jordan@example.com' }),
    })
  ).json();
  const link = await (
    await adminFetch(`/api/reviewers/${reviewer.reviewer.id}/links`, { method: 'POST' })
  ).json();
  magicLinkUrl = link.url.replace('http://localhost:4802', SIDECAR);
});

test.afterAll(() => {
  sidecar?.kill();
});

test('magic link lands in the shell with the screens listed', async ({ page }) => {
  await page.goto(magicLinkUrl);
  await expect(page).toHaveURL(`${SIDECAR}/review/`);
  await expect(page.getByText('signed in as Jordan Client')).toBeVisible();
  await expect(page.getByText('design-round-1')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'In review (17)' })).toBeVisible();
  await expect(page.locator('#frame')).toBeVisible();
});

test('reviewer pins a comment through the story iframe', async ({ page }) => {
  await page.goto(magicLinkUrl);
  await page.locator('#story-list .story', { hasText: 'Components/Button / Primary' }).click();

  const frame = page.frameLocator('#frame');
  await expect(frame.getByRole('button', { name: 'Save changes' })).toBeVisible();

  // Live render fingerprints stream in from the story iframe.
  await expect
    .poll(async () => (await (await adminFetch(`/api/builds/${buildId}/fingerprints`)).json()).count)
    .toBeGreaterThan(0);

  await page.getByRole('button', { name: '📌 Add comment' }).click();
  await expect(frame.getByText('Click what you want to comment on')).toBeVisible();
  const box = await frame.getByRole('button', { name: 'Save changes' }).boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

  await expect(page.getByText('New comment on')).toBeVisible({ timeout: 15000 });
  await page.locator('#composer-text').fill('Please use the green brand color for this button.');
  await page.getByRole('button', { name: 'Post comment' }).click();

  // Composer closes only after the thread is stored.
  await expect(page.locator('#composer-text')).toBeHidden({ timeout: 15000 });
  await expect(
    page.locator('#rail p', { hasText: 'Please use the green brand color for this button.' }),
  ).toBeVisible();

  const feedback = await (await adminFetch('/api/feedback?state=open')).json();
  expect(feedback.feedback).toHaveLength(1);
  expect(feedback.feedback[0].thread.createdBy.kind).toBe('reviewer');
  expect(feedback.feedback[0].thread.screenshotAttachmentId).toBeTruthy();
});

test('reviewer approves one screen, then batch-approves the rest', async ({ page }) => {
  await page.goto(magicLinkUrl);
  await page.locator('#story-list .story', { hasText: 'Components/Badge / Success' }).click();
  await page.locator('#rail').getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.locator('#rail .chip.approved')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Approved (1)' })).toBeVisible();

  await page.getByRole('button', { name: /Approve all remaining \(16\)/ }).click();
  await expect(page.getByText(/You're about to approve/)).toBeVisible();
  await page.getByRole('button', { name: 'Approve 16 screens' }).click();

  await expect(page.getByRole('heading', { name: 'Approved (17)' })).toBeVisible({ timeout: 20000 });

  const stories = await (await adminFetch('/api/stories')).json();
  const states = new Set(stories.stories.map((s: { state: string }) => s.state));
  expect(states).toEqual(new Set(['approved']));
  for (const s of stories.stories) expect(s.anchorBuildId).toBe(buildId);

  // Every approval is a named, direct human action in the audit trail.
  const audit = await (await adminFetch('/api/audit/export')).json();
  const approvals = audit.statusEvents.filter((e: { to: string }) => e.to === 'approved');
  expect(approvals).toHaveLength(17);
  for (const a of approvals) {
    expect(a.approvalMode).toBe('direct');
    expect(a.principal.kind).toBe('reviewer');
    expect(a.principal.name).toBe('Jordan Client');
  }
});
