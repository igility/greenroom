import { createHash, randomUUID, randomBytes } from 'node:crypto';

export const id = () => randomUUID();

export const nowIso = () => new Date().toISOString();

export const sha256Hex = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

export const secret = (bytes = 24) => randomBytes(bytes).toString('base64url');

/** Escape for insertion into an HTML attribute or text node. */
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Stamp a "you are looking at an older build" bar onto a served Storybook index.
 *
 * Deliberately NOT styled like the design system it sits above. A review surface is the
 * one place where tooling chrome must be unmistakably not-the-product — a tasteful banner
 * in the client's own palette is a banner that gets reviewed by mistake. So: dark bar,
 * system font, nothing from the tokens.
 *
 * The link carries the reader to the same story in the newer build rather than dumping
 * them at the root, because the alternative is asking someone to find their place again
 * and they will not bother. `path` comes from the request that served this page; a small
 * inline script refreshes it at click time, since Storybook is a single-page app and the
 * reader will have moved on since. The script only improves the href — with scripting
 * blocked the anchor still works, just aimed at wherever they came in.
 */

/**
 * Stamp the served HTML with the build it came from, for pages whose ADDRESS no longer
 * says. The reviewer lives at the root, which deliberately names no build, so the id
 * travels in the document — the addon reads it to stamp comments and approvals with the
 * build on screen rather than asking the server, which can have moved on under an open
 * tab that never reloaded.
 */
export function withBuildMeta(html: Uint8Array, buildId: string): Uint8Array {
  // Not escaping — constraining. A build id is a UUID this service minted; anything
  // outside id characters is not a build id and has no business in the tag at all.
  const safe = buildId.replace(/[^A-Za-z0-9-]/g, '');
  const tag = `<meta name="greenroom-build" content="${safe}">`;
  const text = Buffer.from(html).toString('utf8');
  const out = text.includes('<head>')
    ? text.replace('<head>', `<head>${tag}`)
    : tag + text;
  return Buffer.from(out, 'utf8');
}


export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public reason?: string,
    /** Structured payload for errors a caller is expected to ACT on rather than merely
     *  report — the upload gate returns the story delta here so the operator can read
     *  what changed without a second round trip. */
    public details?: unknown,
  ) {
    super(message);
  }
}
