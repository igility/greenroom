import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ANCHOR_MANIFEST_FILE, ANCHOR_ATTR, type AnchorManifest } from '@igility/greenroom-shared';
import { MIME } from './routes.js';

/**
 * Builds the anchor manifest by RENDERING the build, not by reading its source.
 *
 * Anchors are produced at render time, so the only way to learn what a build actually
 * contains is to run it. A source parser would answer a different question — what the
 * source CLAIMS — and the two come apart in a way this project has already been bitten
 * by: a `Card` that swallows unknown props renders no attribute at all, so the source
 * says "anchored" and the DOM says nothing. A manifest that over-reports is worse than
 * none, because it makes a deleted item look present and the deletion check silently
 * stops working.
 *
 * Rendering also costs nothing per host: it covers every anchored surface, present and
 * future, with no per-file parser to keep in step.
 *
 * Playwright is imported dynamically. A server deployment never runs this and must not
 * carry a browser to install.
 */

/** The slice of Playwright's Page this uses, declared locally so the server build needs
 *  no type dependency on a package it only optionally imports. */
interface PageLike {
  goto: (url: string, opts: { waitUntil: string; timeout: number }) => Promise<unknown>;
  waitForFunction: (fn: string, arg: undefined, opts: { timeout: number }) => Promise<unknown>;
  evaluate: (fn: string) => Promise<unknown>;
  close: () => Promise<void>;
}

export interface AnchorScanResult {
  manifest: AnchorManifest;
  storiesVisited: number;
  storiesWithAnchors: number;
  totalAnchors: number;
  /** Stories that failed to render. Reported rather than swallowed: a story that errored
   *  contributes no anchors, which is indistinguishable from one that has none — and
   *  that difference is exactly what would turn into a missed deletion. */
  failures: { storyId: string; reason: string }[];
}

/** Serves the built directory so Storybook can load its own modules over http. */
function serveDir(dir: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]!).replace(/^\/+/, '');
    const file = path.resolve(dir, rel || 'index.html');
    if (!file.startsWith(path.resolve(dir)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[file.split('.').pop() ?? ''] ?? 'application/octet-stream',
    });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

export async function scanAnchors(
  dir: string,
  opts: { concurrency?: number; timeoutMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<AnchorScanResult> {
  const indexPath = path.join(dir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`No index.json in ${dir} — point this at a built storybook-static directory.`);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
    entries: Record<string, { type?: string; subtype?: string }>;
  };
  const storyIds = Object.entries(index.entries)
    .filter(([, e]) => e.type === 'story' && (!e.subtype || e.subtype === 'story'))
    .map(([id]) => id);

  /* Specifier held in a variable so TypeScript does not try to resolve a browser
   * automation package the server build has no business depending on. */
  // Either package provides the same launcher, and which one a host has installed is
  // not something to make them think about.
  const CANDIDATES = ['playwright', '@playwright/test'];
  let chromium: {
    launch: () => Promise<{
      newPage: () => Promise<PageLike>;
      close: () => Promise<void>;
    }>;
  };
  let loaded: { chromium: typeof chromium } | null = null;
  for (const spec of CANDIDATES) {
    try {
      loaded = (await import(spec)) as { chromium: typeof chromium };
      break;
    } catch {
      // try the next one
    }
  }
  if (!loaded?.chromium) {
    throw new Error(
      'Generating an anchor manifest needs Playwright and a browser.\n' +
        '  pnpm add -D playwright && npx playwright install chromium',
    );
  }
  ({ chromium } = loaded);

  const timeout = opts.timeoutMs ?? 15000;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const site = await serveDir(dir);
  const browser = await chromium.launch();
  const anchors: Record<string, string[]> = {};
  const failures: { storyId: string; reason: string }[] = [];
  let done = 0;

  const worker = async (queue: string[]) => {
    const page = await browser.newPage();
    for (;;) {
      const storyId = queue.pop();
      if (!storyId) break;
      try {
        await page.goto(
          `http://127.0.0.1:${site.port}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`,
          { waitUntil: 'load', timeout },
        );
        // Storybook mounts asynchronously, so a loaded document is not a rendered one.
        // Waiting for the root to have content is the difference between reading the
        // anchors and reading an empty page.
        // Expressions rather than closures: this code runs in the page, and the server
        // build deliberately has no DOM types. A string keeps the two worlds apart.
        await page.waitForFunction(
          `(() => { const r = document.querySelector('#storybook-root') || document.body;
                    return !!r && r.children.length > 0; })()`,
          undefined,
          { timeout },
        );
        const found = (await page.evaluate(
          `[...document.querySelectorAll('[${ANCHOR_ATTR}]')]
             .map((e) => e.getAttribute('${ANCHOR_ATTR}')).filter(Boolean)`,
        )) as string[];
        if (found.length) anchors[storyId] = [...new Set(found)].sort();
      } catch (err) {
        failures.push({ storyId, reason: err instanceof Error ? err.message.split('\n')[0]! : 'unknown' });
      }
      opts.onProgress?.(++done, storyIds.length);
    }
    await page.close();
  };

  const queue = [...storyIds];
  await Promise.all(Array.from({ length: concurrency }, () => worker(queue)));
  await browser.close();
  await site.close();

  return {
    manifest: { anchors },
    storiesVisited: storyIds.length,
    storiesWithAnchors: Object.keys(anchors).length,
    totalAnchors: Object.values(anchors).reduce((n, a) => n + a.length, 0),
    failures,
  };
}

/** Writes the manifest into the build, where `greenroom upload` will find it. */
export function writeAnchorManifest(dir: string, manifest: AnchorManifest): string {
  const out = path.join(dir, ANCHOR_MANIFEST_FILE);
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  return out;
}
