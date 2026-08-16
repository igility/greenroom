#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Store } from './store.js';
import { zipDir } from './zip.js';

const command = process.argv[2] ?? 'serve';

if (command === 'serve') {
  const config = loadConfig();
  if (config.adminKeyGenerated) {
    console.warn(
      `GREENROOM_ADMIN_KEY not set — generated for this run:\n  ${config.adminKey}\nSet it in the environment to keep a stable key.`,
    );
  }

  /*
   * Fail closed, and do it here rather than in loadConfig so tests and local runs are
   * unaffected. A production deploy that loses this variable would otherwise serve an
   * origin anyone can reach, and it would look completely healthy while doing it —
   * which is the failure you find out about from someone else.
   */
  if (!config.edgeSecret && process.env.NODE_ENV === 'production') {
    console.error(
      'GREENROOM_EDGE_SECRET is not set and NODE_ENV=production.\n' +
        'Refusing to start: the origin would accept requests that bypassed the CDN.\n' +
        'Set it to the same value the CDN attaches as the x-origin-verify header.',
    );
    process.exit(1);
  }
  console.log(
    config.edgeSecret
      ? 'edge check: ON — requests must carry a matching x-origin-verify header'
      : 'edge check: off — no GREENROOM_EDGE_SECRET set (fine for local development)',
  );
  const store = new Store(openDb(config.dataDir), config.dataDir);
  serve({ fetch: createApp(store, config).fetch, port: config.port }, (info) => {
    console.log(`greenroom sidecar listening on http://localhost:${info.port}`);
    console.log(`data dir: ${config.dataDir}`);
  });
} else if (command === 'upload') {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    allowPositionals: true,
    options: {
      url: { type: 'string', default: process.env.GREENROOM_URL ?? 'http://localhost:4788' },
      token: { type: 'string', default: process.env.GREENROOM_TOKEN ?? '' },
      label: { type: 'string' },
      'git-sha': { type: 'string' },
    },
  });
  const dir = positionals[0];
  if (!dir) {
    console.error('Usage: greenroom upload <storybook-static-dir> [--url URL] [--token TOKEN] [--label LABEL] [--git-sha SHA]');
    process.exit(1);
  }
  if (!values.token) {
    console.error('Missing --token (or GREENROOM_TOKEN).');
    process.exit(1);
  }
  const bytes = zipDir(dir);
  const params = new URLSearchParams();
  if (values.label) params.set('label', values.label);
  if (values['git-sha']) params.set('gitSha', values['git-sha']);
  const url = `${values.url.replace(/\/$/, '')}/api/builds?${params}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${values.token}`, 'content-type': 'application/zip' },
    body: bytes,
  });
  const json = (await res.json()) as {
    error?: string;
    created?: boolean;
    newStories?: number;
    build?: { id: string; label: string; storyCount: number };
  };
  if (!res.ok) {
    console.error(`Upload failed (${res.status}): ${json.error ?? 'unknown error'}`);
    process.exit(1);
  }
  if (!json.created) {
    console.log(`Identical build already uploaded — ${json.build?.id} ("${json.build?.label}"). Nothing changed.`);
  } else {
    console.log(
      `Build ${json.build?.id} ("${json.build?.label}") — ${json.build?.storyCount} stories, ${json.newStories} new.`,
    );
  }
} else {
  console.error(`Unknown command: ${command}\nUsage: greenroom [serve|upload]`);
  process.exit(1);
}
