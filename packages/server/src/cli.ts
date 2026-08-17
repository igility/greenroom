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
} else if (command === 'link' || command === 'token' || command === 'reviewer') {
  /*
   * Admin commands, over HTTP rather than by opening the database.
   *
   * The database is on the server; the credential that needs withdrawing is almost
   * always on production, and the person withdrawing it is at a laptop. Going through
   * the API means these work against a deployment, reuse the admin key that already
   * exists in the environment, and add no second way into the store.
   *
   * There is deliberately no browser UI for this yet. An admin authenticates with a
   * bearer key from an environment variable and has no session, so a web surface would
   * either park that master key in browser storage or need a new auth concept first.
   * The terminal already holds the key safely.
   */
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    allowPositionals: true,
    options: {
      url: { type: 'string', default: process.env.GREENROOM_URL ?? 'http://localhost:4788' },
      token: { type: 'string', default: process.env.GREENROOM_ADMIN_KEY ?? process.env.GREENROOM_TOKEN ?? '' },
      reviewer: { type: 'string' },
      expires: { type: 'string' },
      all: { type: 'boolean', default: false },
      'end-all-sessions': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const sub = positionals[0];
  const arg = positionals[1];
  const base = values.url.replace(/\/$/, '');

  const USAGE = `Usage:
  greenroom link list [--reviewer ID] [--all]
  greenroom link new <reviewer-id> [--expires <ISO date>]
  greenroom link revoke <token-prefix> [--end-all-sessions]
  greenroom token list [--all]
  greenroom token revoke <token-id>
  greenroom reviewer list

Common: [--url URL] [--token ADMIN_KEY] [--json]
The admin key defaults to GREENROOM_ADMIN_KEY.`;

  if (!values.token) {
    console.error('Missing --token (or GREENROOM_ADMIN_KEY).');
    process.exit(1);
  }

  const call = async (method: string, path: string, payload?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${values.token}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      console.error(`${method} ${path} failed (${res.status}): ${json.error ?? 'unknown error'}`);
      process.exit(1);
    }
    return json;
  };

  const emit = (value: unknown, human: () => void) => {
    if (values.json) console.log(JSON.stringify(value, null, 2));
    else human();
  };

  const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');

  if (command === 'link' && sub === 'list') {
    const params = new URLSearchParams();
    if (values.reviewer) params.set('reviewerId', values.reviewer);
    if (values.all) params.set('includeInactive', 'true');
    const out = await call('GET', `/api/links?${params}`);
    const links = out.links as {
      tokenPrefix: string;
      reviewer: { name: string; email: string };
      createdAt: string;
      expiresAt: string | null;
      lastUsedAt: string | null;
      revokedAt: string | null;
      liveSessions: number;
      active: boolean;
    }[];
    emit(links, () => {
      if (!links.length) {
        console.log(values.all ? 'No review links.' : 'No active review links.');
        return;
      }
      console.log('LINK        REVIEWER                  CREATED           LAST USED         EXPIRES           SESSIONS  STATE');
      for (const l of links) {
        const state = l.revokedAt ? `revoked ${when(l.revokedAt)}` : l.active ? 'active' : 'expired';
        console.log(
          `${l.tokenPrefix.padEnd(11)} ${`${l.reviewer.name} <${l.reviewer.email}>`.slice(0, 24).padEnd(25)} ` +
            `${when(l.createdAt).padEnd(17)} ${when(l.lastUsedAt).padEnd(17)} ${when(l.expiresAt).padEnd(17)} ` +
            `${String(l.liveSessions).padEnd(9)} ${state}`,
        );
      }
      // The default is no expiry, so this is the common case rather than an edge one.
      const forever = links.filter((l) => !l.expiresAt && l.active).length;
      if (forever) {
        console.log(
          `\n${forever} active link(s) never expire. A link is reusable — anyone holding the URL can get in until it is revoked.`,
        );
      }
    });
  } else if (command === 'link' && sub === 'new') {
    if (!arg) {
      console.error('Usage: greenroom link new <reviewer-id> [--expires <ISO date>]');
      process.exit(1);
    }
    const out = await call('POST', `/api/reviewers/${encodeURIComponent(arg)}/links`, {
      ...(values.expires ? { expiresAt: values.expires } : {}),
    });
    emit(out, () => {
      console.log(out.url);
      if (!values.expires) {
        console.log('\nThis link never expires and can be redeemed any number of times.');
        console.log('Set --expires <ISO date> to bound it, or revoke it when the review closes.');
      }
    });
  } else if (command === 'link' && sub === 'revoke') {
    if (!arg) {
      console.error('Usage: greenroom link revoke <token-prefix> [--end-all-sessions]');
      process.exit(1);
    }
    const out = (await call('POST', `/api/links/${encodeURIComponent(arg)}/revoke`, {
      endAllSessions: values['end-all-sessions'],
    })) as {
      reviewer: { name: string; email: string };
      sessionsEnded: number;
      unattributedSessions: number;
    };
    emit(out, () => {
      console.log(`Revoked. ${out.reviewer.name} <${out.reviewer.email}>`);
      console.log(`Sessions ended: ${out.sessionsEnded}`);
      if (out.unattributedSessions > 0) {
        // Sessions predating the attribution column cannot be matched to a link. Saying
        // so is the point: a revocation the operator believes is complete, and is not,
        // is worse than one that reports its own limit.
        console.log(
          `\n⚠ ${out.unattributedSessions} other live session(s) for this reviewer could not be\n` +
            `  attributed to a link (created before sessions recorded one). They are still valid.\n` +
            `  Re-run with --end-all-sessions to end those too — it will also sign out this\n` +
            `  reviewer everywhere, including from any other link they legitimately hold.`,
        );
      }
    });
  } else if (command === 'token' && sub === 'list') {
    const out = await call('GET', `/api/tokens?${values.all ? 'includeRevoked=true' : ''}`);
    const tokens = out.tokens as {
      id: string;
      kind: string;
      name: string;
      createdAt: string;
      revokedAt: string | null;
    }[];
    emit(tokens, () => {
      if (!tokens.length) {
        console.log(values.all ? 'No tokens.' : 'No active tokens.');
        return;
      }
      console.log('ID                                    KIND    CREATED           NAME');
      for (const t of tokens) {
        const suffix = t.revokedAt ? `  (revoked ${when(t.revokedAt)})` : '';
        console.log(`${t.id.padEnd(37)} ${t.kind.padEnd(7)} ${when(t.createdAt).padEnd(17)} ${t.name}${suffix}`);
      }
    });
  } else if (command === 'token' && sub === 'revoke') {
    if (!arg) {
      console.error('Usage: greenroom token revoke <token-id>');
      process.exit(1);
    }
    const out = (await call('POST', `/api/tokens/${encodeURIComponent(arg)}/revoke`)) as {
      token: { kind: string; name: string };
    };
    emit(out, () => console.log(`Revoked ${out.token.kind} token "${out.token.name}".`));
  } else if (command === 'reviewer' && sub === 'list') {
    const out = await call('GET', '/api/reviewers');
    const reviewers = out.reviewers as { id: string; name: string; email: string; role: string }[];
    emit(reviewers, () => {
      if (!reviewers.length) {
        console.log('No reviewers.');
        return;
      }
      console.log('ID                                    ROLE       NAME');
      for (const r of reviewers) {
        console.log(`${r.id.padEnd(37)} ${r.role.padEnd(10)} ${r.name} <${r.email}>`);
      }
    });
  } else {
    console.error(USAGE);
    process.exit(1);
  }
} else {
  console.error(
    `Unknown command: ${command}\nUsage: greenroom [serve|upload|link|token|reviewer]`,
  );
  process.exit(1);
}
