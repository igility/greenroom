import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openMemoryDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { defaultShellDir } from '../src/config.js';
import type { Config } from '../src/config.js';

/**
 * The stable address.
 *
 * A reviewer's magic link used to redirect into /builds/<id>/…, which put the build in
 * the address bar. People bookmark where they are, not where they entered, so the
 * natural move — bookmark the page — pinned them to one build forever. And the year-long
 * immutable cache on that page meant the stale-build banner, the one signal that would
 * have told them, was served from browser cache and never arrived. Both happened to a
 * real client on the same day; that is the incident these lock in.
 */

const ADMIN = 'test-admin-key';
const enc = (s: string) => new TextEncoder().encode(s);

const build = (marker: string, html = `<html><head><title>sb</title></head><body>${marker}</body></html>`) =>
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
    'index.html': enc(html),
    'iframe.html': enc(`<html><body>${marker}</body></html>`),
    'assets/app.js': enc(`console.log("${marker}")`),
  });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-latest-'));
const config: Config = {
  dataDir,
  port: 0,
  publicUrl: 'http://greenroom.test',
  adminKey: ADMIN,
  adminKeyGenerated: false,
  shellDir: defaultShellDir(),
  edgeSecret: '',
  smtpUrl: '',
  mailFrom: '',
  selfServiceLinkTtlHours: 72,
};
const store = new Store(openMemoryDb(), dataDir);
const app = createApp(store, config);
const H = { authorization: `Bearer ${ADMIN}` };

const upload = (zip: Uint8Array, label: string) =>
  app.request(`/api/builds?label=${label}&allowStoryChanges=1`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/zip' },
    body: zip,
  });

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('/latest/ — the address a reviewer can live at', () => {
  it('serves whatever build is newest, and moves when a new one lands', async () => {
    await upload(build('FIRST'), 'v1');
    const r1 = await app.request('/latest/iframe.html', { headers: H });
    expect(await r1.text()).toContain('FIRST');

    await upload(build('SECOND'), 'v2');
    const r2 = await app.request('/latest/iframe.html', { headers: H });
    // Same address, new content — the property the pinned URL cannot have.
    expect(await r2.text()).toContain('SECOND');
  });

  it('stamps the build id into the html, because the address no longer says', async () => {
    // The addon stamps comments with the build ON SCREEN, read from the path. /latest/
    // has no id in the path by design, so it travels in the document instead — without
    // it, a tab open across an upload would mis-stamp again.
    const latest = store.latestBuild()!;
    const html = await (await app.request('/latest/index.html', { headers: H })).text();
    expect(html).toContain(`<meta name="greenroom-build" content="${latest.id}">`);
  });

  it('must never be cached — what it serves changes on every upload', async () => {
    const r = await app.request('/latest/index.html', { headers: H });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('requires a principal, same as the pinned build routes', async () => {
    const r = await app.request('/latest/index.html');
    expect(r.status).toBe(401);
  });

  it('404s before the first upload rather than erroring', async () => {
    const empty = createApp(new Store(openMemoryDb(), dataDir), config);
    const r = await empty.request('/latest/index.html', { headers: H });
    expect(r.status).toBe(404);
  });
});

describe('the pinned address stays honest', () => {
  it('html under /builds/ is no longer cached for a year', async () => {
    // The stale-build banner is injected AT SERVE TIME into an old build's index.html.
    // cache-control: immutable meant a returning visitor got the cached copy and the
    // banner never arrived — a reviewer sat on an old build with the one signal that
    // would have told them suppressed by a header.
    const b = store.latestBuild()!;
    const html = await app.request(`/builds/${b.id}/index.html`, { headers: H });
    expect(html.headers.get('cache-control')).toBe('no-store');
    // Assets keep the year: they really are immutable.
    const asset = await app.request(`/builds/${b.id}/assets/app.js`, { headers: H });
    expect(asset.headers.get('cache-control')).toContain('immutable');
  });

  it('an old build warns, and the banner points at the stable address', async () => {
    const old = store
      .listBuilds()
      .find((b) => b.id !== store.latestBuild()!.id)!;
    const html = await (await app.request(`/builds/${old.id}/index.html`, { headers: H })).text();
    expect(html).toContain('older build');
    // Pointing at the newest PINNED url would hand out a fresh address that rots in
    // turn; the next bookmark recreates the trap the banner exists to escape.
    expect(html).toContain('href="/latest/index.html"');
  });

  it('the current build gets no banner', async () => {
    const b = store.latestBuild()!;
    const html = await (await app.request(`/builds/${b.id}/index.html`, { headers: H })).text();
    expect(html).not.toContain('older build');
  });
});
