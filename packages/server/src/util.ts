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
export function withStaleBuildNotice(
  html: Uint8Array,
  latestBuildId: string,
  path?: string,
): Uint8Array {
  const base = `/builds/${encodeURIComponent(latestBuildId)}/index.html`;
  const href = path ? `${base}?path=${encodeURIComponent(path)}` : base;

  const bar = `
<div id="greenroom-stale-build" style="position:fixed;inset:0 0 auto 0;z-index:2147483647;
  background:#1f2124;color:#fff;font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  padding:9px 14px;display:flex;gap:12px;align-items:center;justify-content:center;
  box-shadow:0 1px 0 rgba(255,255,255,.14)">
  <span>You are looking at an <strong>older build</strong>. It has been replaced since you opened it.</span>
  <a id="greenroom-stale-build-link" href="${escapeHtml(href)}"
     style="color:#fff;background:rgba(255,255,255,.16);border-radius:6px;padding:4px 10px;
     text-decoration:none;white-space:nowrap">Open the latest &rarr;</a>
  <button type="button" onclick="document.getElementById('greenroom-stale-build').remove()"
     aria-label="Dismiss" style="background:none;border:0;color:rgba(255,255,255,.6);
     font-size:16px;line-height:1;cursor:pointer;padding:2px 4px">&times;</button>
</div>
<script>(function(){var a=document.getElementById('greenroom-stale-build-link');if(!a)return;
a.addEventListener('click',function(){var p=new URLSearchParams(location.search).get('path');
if(p)a.href=${JSON.stringify(base)}+'?path='+encodeURIComponent(p);});})();</script>`;

  const text = Buffer.from(html).toString('utf8');
  // Append rather than prepend: the bar is fixed-position, so where it sits in the
  // document does not affect where it renders, and appending cannot disturb anything
  // Storybook's own boot sequence expects to find first.
  const out = text.includes('</body>')
    ? text.replace('</body>', `${bar}\n</body>`)
    : text + bar;
  return new Uint8Array(Buffer.from(out, 'utf8'));
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
