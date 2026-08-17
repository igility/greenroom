import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openMemoryDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { memoryMailer } from '../src/mail.js';
import { defaultShellDir } from '../src/config.js';
import type { Config } from '../src/config.js';

/**
 * Self-service review links.
 *
 * This is the only endpoint in the product that is unauthenticated by necessity — the
 * caller has no session, which is the whole situation — and it sends credentials by
 * email. Its security properties matter more than the feature does, so that is what
 * these test.
 */

let dataDir: string;
let store: Store;
let mailer: ReturnType<typeof memoryMailer>;
let app: ReturnType<typeof createApp>;

const config = (over: Partial<Config> = {}): Config => ({
  dataDir,
  port: 0,
  publicUrl: 'https://review.example.com',
  adminKey: 'k',
  adminKeyGenerated: false,
  shellDir: defaultShellDir(),
  edgeSecret: '',
  smtpUrl: 'smtp://unused',
  mailFrom: 'greenroom@example.com',
  selfServiceLinkTtlHours: 72,
  ...over,
});

const ask = (email: string, ip = '203.0.113.7') =>
  app.request('/api/review-links/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email }),
  });

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-linkreq-'));
  store = new Store(openMemoryDb(), dataDir);
  store.createReviewer({ name: 'Jordan Client', email: 'jordan@example.com' });
  mailer = memoryMailer();
  app = createApp(store, config(), mailer);
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('asking for a review link', () => {
  it('emails a working link to an address on the review', async () => {
    const res = await ask('jordan@example.com');
    expect(res.status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('jordan@example.com');

    // Not merely a plausible URL — the token in it must actually redeem.
    const token = mailer.sent[0]!.url.replace('https://review.example.com/review/', '');
    expect(store.redeemMagicLink(token).reviewer.name).toBe('Jordan Client');
  });

  it('matches the address case-insensitively', async () => {
    await ask('Jordan@Example.COM');
    expect(mailer.sent).toHaveLength(1);
  });

  it('answers an unknown address exactly as it answers a known one', async () => {
    // The property that stops this being a directory of who is reviewing an unreleased
    // product. Point it at a list of addresses and every reply must look the same.
    const known = await ask('jordan@example.com');
    const unknown = await ask('nobody@example.com', '198.51.100.4');
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
    expect(mailer.sent).toHaveLength(1); // and nothing was sent to the stranger
  });

  it('cannot create a reviewer', async () => {
    await ask('stranger@example.com');
    expect(store.listReviewers().map((r) => r.email)).toEqual(['jordan@example.com']);
    expect(mailer.sent).toHaveLength(0);
  });

  it('bounds the link it sends, unlike an admin-minted one', async () => {
    // An admin link defaults to never expiring. A self-service one has no reason to:
    // another is one form submission away, and a short life is what stops a forwarded
    // copy being useful next month.
    await ask('jordan@example.com');
    const [link] = store.listMagicLinks();
    expect(link!.expiresAt).not.toBeNull();
    const hours = (Date.parse(link!.expiresAt!) - Date.now()) / 36e5;
    expect(hours).toBeGreaterThan(71);
    expect(hours).toBeLessThan(73);
  });

  it('stops sending after a few requests, and says nothing different when it does', async () => {
    const replies = [];
    for (let i = 0; i < 5; i++) replies.push(await ask('jordan@example.com'));
    expect(mailer.sent.length).toBe(3);
    // A rate-limited caller must not be able to tell they were limited — otherwise the
    // limiter itself becomes the oracle the constant response was protecting.
    const first = await replies[0]!.json();
    const last = await replies[4]!.json();
    expect(replies[4]!.status).toBe(replies[0]!.status);
    expect(last).toEqual(first);
  });

  it('limits by address, so a caller changing IP cannot keep going', async () => {
    for (let i = 0; i < 5; i++) await ask('jordan@example.com', `198.51.100.${i}`);
    expect(mailer.sent.length).toBe(3);
  });

  it('leaves no live link behind when the send fails', async () => {
    const failing = {
      enabled: true,
      async sendReviewLink() {
        throw new Error('smtp down');
      },
    };
    const isolated = createApp(store, config(), failing);
    const res = await isolated.request('/api/review-links/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'jordan@example.com' }),
    });
    // The caller is told the same thing regardless, but a credential nobody received
    // must not be left valid in the table.
    expect(res.status).toBe(200);
    expect(store.listMagicLinks()).toHaveLength(0);
    expect(store.listMagicLinks({ includeInactive: true })).toHaveLength(1);
  });
});

describe('advertising whether self-service is available', () => {
  it('says so when mail is configured', async () => {
    expect((await (await app.request('/api/health')).json()).selfServiceLinks).toBe(true);
  });

  it('says so when it is not, so the gate does not offer a form that does nothing', async () => {
    const noMail = createApp(store, config({ smtpUrl: '', mailFrom: '' }));
    expect((await (await noMail.request('/api/health')).json()).selfServiceLinks).toBe(false);
  });

  it('sends nothing when mail is unconfigured, and still answers the same', async () => {
    const noMail = createApp(store, config({ smtpUrl: '', mailFrom: '' }));
    const res = await noMail.request('/api/review-links/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'jordan@example.com' }),
    });
    expect(res.status).toBe(200);
    expect(store.listMagicLinks({ includeInactive: true })).toHaveLength(0);
  });
});
