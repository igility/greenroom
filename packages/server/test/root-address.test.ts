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
 * The reviewer's address is the root, and it names nothing.
 *
 * A link identifies and authenticates a person; the newest build is always what is
 * served. Any version token in the address — a build id, or even the word "latest" — is
 * a thing someone can bookmark and be stranded on, and both spellings of that mistake
 * were made here before this design: a pinned /builds/<id> URL stranded the client and
 * then the operator, on the same day.
 */

const ADMIN = 'test-admin-key';
const enc = (s: string) => new TextEncoder().encode(s);

const build = (marker: string) =>
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
    'index.html': enc(`<html><head><title>sb</title></head><body>${marker}</body></html>`),
    'iframe.html': enc(`<html><body>${marker}</body></html>`),
    'assets/app-HASH123.js': enc(`console.log("${marker}")`),
    'sb-addons/greenroom/manager-bundle.js': enc(`/* ${marker} */`),
  });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-root-'));
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

describe('the root serves the newest build', () => {
  it('serves it, and moves when a new one lands — same address, new content', async () => {
    await upload(build('FIRST'), 'v1');
    expect(await (await app.request('/iframe.html', { headers: H })).text()).toContain('FIRST');
    await upload(build('SECOND'), 'v2');
    expect(await (await app.request('/iframe.html', { headers: H })).text()).toContain('SECOND');
  });

  it('serves index.html at the bare root path', async () => {
    const r = await app.request('/', { headers: H });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('SECOND');
  });

  it('stamps the build id into the html, because the address names nothing', async () => {
    const latest = store.latestBuild()!;
    const html = await (await app.request('/index.html', { headers: H })).text();
    expect(html).toContain(`<meta name="greenroom-build" content="${latest.id}">`);
  });

  it('caches only the content-hashed assets — everything else changes on upload', async () => {
    // index.html, index.json, and the UNHASHED sb-addons bundles all change meaning
    // when a build lands; a cached copy is a stale surface with no signal attached.
    const html = await app.request('/index.html', { headers: H });
    expect(html.headers.get('cache-control')).toBe('no-store');
    const idx = await app.request('/index.json', { headers: H });
    expect(idx.headers.get('cache-control')).toBe('no-store');
    const addon = await app.request('/sb-addons/greenroom/manager-bundle.js', { headers: H });
    expect(addon.headers.get('cache-control')).toBe('no-store');
    const asset = await app.request('/assets/app-HASH123.js', { headers: H });
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.headers.get('cache-control')).toContain('private');
  });

  it('sends an unauthenticated PERSON to the gate, and an unauthenticated fetch away', async () => {
    const page = await app.request('/');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/review/');
    const asset = await app.request('/assets/app-HASH123.js');
    expect(asset.status).toBe(401);
  });

  it('does not swallow the API or the gate', async () => {
    // The catch-all is registered last; everything specific must still win.
    const health = await app.request('/api/health');
    expect((await health.json()).name).toBe('greenroom');
    const gate = await app.request('/review/');
    expect(gate.headers.get('content-type')).toContain('text/html');
  });
});

describe('old addresses heal themselves', () => {
  it('a pinned build bookmark redirects permanently to the root path', async () => {
    const old = store.listBuilds().at(-1)!;
    const r = await app.request(`/builds/${old.id}/index.html`, { headers: H });
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe('/index.html');
  });

  it('carries the story deep-link through the redirect', async () => {
    const old = store.listBuilds().at(-1)!;
    const r = await app.request(
      `/builds/${old.id}/index.html?path=/story/components-button--primary`,
      { headers: H },
    );
    expect(r.headers.get('location')).toBe('/index.html?path=/story/components-button--primary');
  });

  it('the /latest spelling redirects too — it was the same mistake wearing a safer name', async () => {
    const r = await app.request('/latest/index.html', { headers: H });
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe('/index.html');
  });
});

describe('before the first upload', () => {
  it('404s rather than erroring', async () => {
    const empty = createApp(new Store(openMemoryDb(), dataDir), config);
    const r = await empty.request('/index.html', { headers: H });
    expect(r.status).toBe(404);
  });
});
