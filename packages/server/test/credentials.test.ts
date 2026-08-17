import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { HttpError } from '../src/util.js';

/**
 * Withdrawing access.
 *
 * Until this existed, no credential Greenroom issued could be taken back. `revoked_at`
 * was on `magic_links` and `redeemMagicLink` checked it, but nothing ever wrote it — so
 * the check was unreachable. The only code that removed a link was `deleteReviewer`,
 * which refuses outright once a reviewer has taken part; for anyone who had actually
 * reviewed something, their link could not be invalidated at all. Links are reusable and
 * never expire unless an expiry is supplied, so a forwarded URL was permanent access to
 * an unreleased design system.
 */

let dataDir: string;
let db: ReturnType<typeof openMemoryDb>;
let store: Store;
let reviewerId: string;

/** Make every session for the reviewer look like a pre-v8 row: created before sessions
 *  recorded which link minted them, and therefore unattributable. */
const unattributeSessions = () =>
  db.prepare('UPDATE sessions SET magic_link_token = NULL WHERE reviewer_id = ?').run(reviewerId);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-cred-'));
  db = openMemoryDb();
  store = new Store(db, dataDir);
  reviewerId = store.createReviewer({ name: 'Jordan Client', email: 'jordan@example.com' }).id;
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('revoking a review link', () => {
  it('stops the link being redeemed again', () => {
    const token = store.createMagicLink(reviewerId);
    expect(store.redeemMagicLink(token).reviewer.name).toBe('Jordan Client');

    store.revokeMagicLink(token);

    // The branch that was unreachable for the whole life of the product.
    expect(() => store.redeemMagicLink(token)).toThrowError(/no longer valid/i);
  });

  it('ends the sessions that link already minted', () => {
    // The half that makes it a revocation rather than a gesture. Setting revoked_at
    // alone stops future redemptions and leaves whoever the link reached holding a
    // thirty-day session — the entire window the revocation was meant to close.
    const token = store.createMagicLink(reviewerId);
    const a = store.redeemMagicLink(token).sessionId;
    const b = store.redeemMagicLink(token).sessionId;
    expect(store.sessionReviewer(a)).not.toBeNull();

    const out = store.revokeMagicLink(token);

    expect(out.sessionsEnded).toBe(2);
    expect(store.sessionReviewer(a)).toBeNull();
    expect(store.sessionReviewer(b)).toBeNull();
  });

  it('leaves a second link and its sessions working', () => {
    // Why sessions record which link minted them. Without that, revoking one link can
    // only end every session the reviewer has, signing out someone who legitimately
    // holds a different link.
    const leaked = store.createMagicLink(reviewerId);
    const kept = store.createMagicLink(reviewerId);
    const leakedSession = store.redeemMagicLink(leaked).sessionId;
    const keptSession = store.redeemMagicLink(kept).sessionId;

    store.revokeMagicLink(leaked);

    expect(store.sessionReviewer(leakedSession)).toBeNull();
    expect(store.sessionReviewer(keptSession)).not.toBeNull();
    expect(store.redeemMagicLink(kept).reviewer.id).toBe(reviewerId);
  });

  it('reports sessions it cannot attribute instead of pretending they are gone', () => {
    // A session created before v8 carries no link. Sweeping it up silently would sign
    // out a reviewer holding another link; ignoring it silently would leave the operator
    // believing a revocation was complete when it was not. So it is counted and named.
    const token = store.createMagicLink(reviewerId);
    store.redeemMagicLink(token);
    // Exactly what a pre-v8 row looks like.
    unattributeSessions();

    const out = store.revokeMagicLink(token);
    expect(out.sessionsEnded).toBe(0);
    expect(out.unattributedSessions).toBe(1);
  });

  it('ends the unattributable ones too when explicitly asked', () => {
    const token = store.createMagicLink(reviewerId);
    const session = store.redeemMagicLink(token).sessionId;
    unattributeSessions();

    const out = store.revokeMagicLink(token, { endAllSessions: true });
    expect(out.sessionsEnded).toBe(1);
    expect(store.sessionReviewer(session)).toBeNull();
  });

  it('is identified by a prefix, and refuses an ambiguous one', () => {
    const token = store.createMagicLink(reviewerId);
    // A revocation aimed at the wrong reviewer is worse than making someone retype, so
    // ambiguity is refused rather than resolved to the first match.
    expect(() => store.revokeMagicLink(token.slice(0, 3))).toThrowError(/at least 6/i);
    expect(() => store.revokeMagicLink('zzzzzzzzzz')).toThrowError(/No review link/i);
    expect(store.revokeMagicLink(token.slice(0, 10)).reviewer.id).toBe(reviewerId);
  });

  it('can be revoked twice without changing when it happened', () => {
    const token = store.createMagicLink(reviewerId);
    store.revokeMagicLink(token);
    const first = store.listMagicLinks({ includeInactive: true })[0]!.revokedAt;
    store.revokeMagicLink(token);
    expect(store.listMagicLinks({ includeInactive: true })[0]!.revokedAt).toBe(first);
  });
});

describe('listing review links', () => {
  it('never returns a whole token', () => {
    // A listing that prints working credentials into terminal scrollback and shell
    // history is a leak, and an admin who needs a live link can mint one.
    const token = store.createMagicLink(reviewerId);
    const [link] = store.listMagicLinks();
    expect(link!.tokenPrefix.length).toBeLessThan(token.length);
    expect(token.startsWith(link!.tokenPrefix)).toBe(true);
    expect(JSON.stringify(store.listMagicLinks())).not.toContain(token);
  });

  it('hides revoked links by default and shows them on request', () => {
    const token = store.createMagicLink(reviewerId);
    store.revokeMagicLink(token);
    expect(store.listMagicLinks()).toHaveLength(0);
    // Kept rather than deleted: "this was withdrawn on the 14th" is the answer to a
    // question somebody will ask, and a deleted row answers nothing.
    expect(store.listMagicLinks({ includeInactive: true })).toHaveLength(1);
  });

  it('reports an expired link as inactive without it being revoked', () => {
    store.createMagicLink(reviewerId, '2020-01-01T00:00:00.000Z');
    const [link] = store.listMagicLinks({ includeInactive: true });
    expect(link!.active).toBe(false);
    expect(link!.revokedAt).toBeNull();
  });

  it('counts the live sessions a link is holding open', () => {
    const token = store.createMagicLink(reviewerId);
    store.redeemMagicLink(token);
    store.redeemMagicLink(token);
    expect(store.listMagicLinks()[0]!.liveSessions).toBe(2);
  });
});

describe('revoking an agent token', () => {
  it('stops the token authenticating', () => {
    const { id, token } = store.createToken('agent', 'ci');
    expect(store.findToken(token)).not.toBeNull();
    store.revokeToken(id);
    expect(store.findToken(token)).toBeNull();
  });

  it('lists tokens without their secret, hiding revoked ones by default', () => {
    const { id, token } = store.createToken('agent', 'ci');
    expect(JSON.stringify(store.listTokens())).not.toContain(token);
    store.revokeToken(id);
    expect(store.listTokens()).toHaveLength(0);
    expect(store.listTokens({ includeRevoked: true })).toHaveLength(1);
  });

  it('refuses an id it does not know', () => {
    expect(() => store.revokeToken('nope')).toThrowError(HttpError);
  });
});
