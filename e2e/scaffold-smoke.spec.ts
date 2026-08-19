import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { test, expect } from '@playwright/test';

// Self-contained: serve the built demo Storybook ourselves so the suite runs
// from a fresh clone (after `pnpm build` + `pnpm build:demo`) with no external
// server assumed. Uses a dedicated port to avoid collisions with other specs.
const ROOT = process.cwd();
const PORT = 6228;
const BASE = `http://localhost:${PORT}`;
const STORYBOOK_STATIC = path.join(ROOT, 'examples/demo-storybook/storybook-static');

let staticServer: ChildProcess;

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
  staticServer = spawn('node', ['e2e/static-server.mjs', STORYBOOK_STATIC, String(PORT)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  await waitFor(`${BASE}/iframe.html`);
});

test.afterAll(() => {
  staticServer?.kill();
});

test('demo storybook renders a story and mounts the Greenroom Review panel', async ({ page }) => {
  await page.goto(`${BASE}/?path=/story/components-button--primary`);

  const preview = page.frameLocator('#storybook-preview-iframe');
  await expect(preview.getByRole('button', { name: 'Save changes' })).toBeVisible();

  await page.getByRole('tab', { name: 'Greenroom' }).click();
  // With no sidecar configured, the panel shows its connect form — proof the
  // addon registered and mounted its React panel in a real built Storybook.
  await expect(page.getByText('Connect this panel to a Greenroom sidecar')).toBeVisible();

  await page.screenshot({ path: 'e2e/.artifacts/scaffold-smoke.png', fullPage: true });
});
