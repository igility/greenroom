import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

const ROOT = process.cwd();
const ADMIN = 'e2e-admin-key';
const SIDECAR = 'http://localhost:4799';
const STATIC = 'http://localhost:6218';
const DATA_DIR = path.join(ROOT, 'e2e/.artifacts/addon-data');
const STORYBOOK_STATIC = path.join(ROOT, 'examples/demo-storybook/storybook-static');

let sidecar: ChildProcess;
let staticServer: ChildProcess;

async function waitFor(url: string, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
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
      GREENROOM_PORT: '4799',
    },
    stdio: 'inherit',
  });
  await waitFor(`${SIDECAR}/api/health`);

  const upload = spawnSync(
    'node',
    [
      'packages/server/dist/cli.js',
      'upload',
      STORYBOOK_STATIC,
      '--url',
      SIDECAR,
      '--token',
      ADMIN,
      '--label',
      'e2e-build-a',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(upload.status, upload.stderr).toBe(0);

  staticServer = spawn('node', ['e2e/static-server.mjs', STORYBOOK_STATIC, '6218'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  await waitFor(`${STATIC}/iframe.html`);
});

test.afterAll(() => {
  sidecar?.kill();
  staticServer?.kill();
});

test('dev panel: connect → pin comment → thread → approve', async ({ page }) => {
  await page.goto(`${STATIC}/?path=/story/components-button--primary`);

  await page.getByRole('tab', { name: 'Review' }).click();

  await page.getByLabel('Sidecar URL').fill(SIDECAR);
  await page.getByLabel('API token').fill(ADMIN);
  await page.getByRole('button', { name: 'Connect' }).click();

  await expect(page.getByText('In review')).toBeVisible();

  // Drop a pin on the rendered button inside the preview iframe.
  await page.getByRole('button', { name: '📌 Comment on element' }).click();
  const frame = page.frameLocator('#storybook-preview-iframe');
  await expect(frame.getByText('Click what you want to comment on')).toBeVisible();

  const targetBox = await frame.getByRole('button', { name: 'Save changes' }).boundingBox();
  expect(targetBox).toBeTruthy();
  await page.mouse.click(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2);

  await expect(page.getByText(/New comment on/)).toBeVisible({ timeout: 15000 });
  await page
    .getByPlaceholder('What should change?')
    .fill('Make the save button green to match the brand.');
  await page.getByRole('button', { name: 'Post comment' }).click();

  // The composer closes only after the thread round-trip succeeds — that's the
  // real completion signal. A bare getByText would match the textarea's own
  // value and race ahead of the POST.
  await expect(page.getByPlaceholder('What should change?')).toBeHidden({ timeout: 15000 });
  await expect(
    page.locator('p', { hasText: 'Make the save button green to match the brand.' }),
  ).toBeVisible();

  // The store now holds the full context bundle an agent needs.
  await expect
    .poll(async () => {
      const r = await (
        await fetch(`${SIDECAR}/api/feedback?state=open`, {
          headers: { authorization: `Bearer ${ADMIN}` },
        })
      ).json();
      return r.feedback.length;
    })
    .toBe(1);
  const feedback = await (
    await fetch(`${SIDECAR}/api/feedback?state=open`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    })
  ).json();
  expect(feedback.feedback).toHaveLength(1);
  const item = feedback.feedback[0];
  expect(item.story.storyId).toBe('components-button--primary');
  expect(item.story.importPath).toContain('Button.stories');
  expect(item.thread.pin.selector).toContain('button');
  expect(item.thread.screenshotAttachmentId).toBeTruthy();
  expect(item.thread.args).toMatchObject({ label: 'Save changes' });

  // Approve from the panel; approval anchors to the uploaded build.
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();

  const story = await (
    await fetch(`${SIDECAR}/api/stories/components-button--primary`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    })
  ).json();
  expect(story.story.state).toBe('approved');
  expect(story.story.anchorBuildId).toBeTruthy();

  await page.screenshot({ path: 'e2e/.artifacts/addon-panel.png', fullPage: true });
});
