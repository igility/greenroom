import type { Store } from './store.js';
import type { Config } from './config.js';
import type { Mailer } from './mail.js';

/**
 * Self-service review links.
 *
 * The gate a reviewer without a session lands on used to end the conversation: "ask your
 * contact for a fresh one". That makes losing access a support request, and it is the
 * reason the whole flow reads as a prototype. This lets them ask for themselves.
 *
 * It is the one endpoint in the product that is unauthenticated by necessity — the
 * caller has no session, which is the entire situation — and it sends credentials by
 * email. So its security properties matter more than the feature does.
 *
 * 🔴 THE RESPONSE IS ALWAYS IDENTICAL. Same body, same status, whether the address
 * belongs to a reviewer, belongs to nobody, or was rate-limited. Anything else turns
 * this into a directory: point it at a list of addresses and it tells you which people
 * are reviewing an unreleased product, which is exactly the fact a client would least
 * like leaked.
 *
 * 🔴 IT CANNOT CREATE A REVIEWER. It re-issues access to someone an admin already
 * invited. An endpoint that could mint one would be an open door.
 *
 * The links it sends expire — by default in three days. A self-service link has no
 * reason to be long-lived when getting another costs one form submission, and short
 * expiry is what keeps a forwarded copy from being useful next month.
 */

/** Requests allowed per address, and per caller, inside the window. Deliberately small:
 *  the honest use is "I lost my link", which happens once, not five times an hour. */
const MAX_PER_WINDOW = 3;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * In-memory, which is the right size for this. The sidecar is a single process, the
 * counters are worth nothing once it restarts, and persisting them would mean a write on
 * every unauthenticated request — a denial-of-service amplifier rather than a defence.
 */
class RateLimiter {
  private hits = new Map<string, number[]>();

  /** True when the caller is inside their allowance. Also prunes, so the map cannot grow
   *  without bound just because someone points a script at it. */
  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_PER_WINDOW) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) {
      for (const [k, times] of this.hits) {
        if (!times.some((t) => now - t < WINDOW_MS)) this.hits.delete(k);
      }
    }
    return true;
  }
}

export interface LinkRequestResult {
  /** Always true to the caller. Present for tests and logs, never for the response. */
  sent: boolean;
  reason?: 'unknown-address' | 'rate-limited' | 'send-failed';
}

export function createLinkRequestHandler(store: Store, config: Config, mailer: Mailer) {
  const byAddress = new RateLimiter();
  const byCaller = new RateLimiter();

  return async function requestReviewLink(
    email: string,
    callerKey: string,
    now = Date.now(),
  ): Promise<LinkRequestResult> {
    const address = email.trim().toLowerCase();

    // Nothing to do at all without a mailer, and doing it anyway is worse than useless:
    // the link gets minted, the send throws, and the link is revoked again — so every
    // unauthenticated request writes two rows to show for nothing. No information leaks
    // by returning early, because the capability is off for everybody uniformly and is
    // already advertised on /api/health.
    if (!mailer.enabled) return { sent: false, reason: 'send-failed' };

    // Rate limit before the lookup, so a limited request costs the same as an unknown
    // one and neither reveals anything by how long it took.
    if (!byCaller.allow(callerKey, now) || !byAddress.allow(address, now)) {
      return { sent: false, reason: 'rate-limited' };
    }

    const reviewer = store.findReviewerByEmail(address);
    if (!reviewer) return { sent: false, reason: 'unknown-address' };

    const expiresAt = new Date(
      now + config.selfServiceLinkTtlHours * 60 * 60 * 1000,
    ).toISOString();
    const token = store.createMagicLink(reviewer.id, expiresAt);

    try {
      await mailer.sendReviewLink(reviewer.email, `${config.publicUrl}/review/${token}`);
    } catch (err) {
      // The link exists but nobody received it. Revoke rather than leave a live
      // credential nobody asked for lying in the table.
      store.revokeMagicLink(token);
      console.error('review link send failed:', err);
      return { sent: false, reason: 'send-failed' };
    }
    return { sent: true };
  };
}
