/**
 * Render fingerprints are an ASSIST, never an authority. They pre-sort the re-confirm
 * queue ("likely unchanged" vs "changed") after a new build — they never carry an
 * approval forward on their own. Known v0 blind spot: styles injected outside the story
 * root (CSS-in-JS in <head>, external stylesheet edits) don't move the hash.
 */

/** React useId output formats across major versions (`:r1:`, `«r1»`). */
const GENERATED_ID_PATTERNS = [/«r[0-9a-z]+»/g, /:r[0-9a-z]+:/gi];

/** Normalize a serialized DOM snapshot so volatile, render-random noise doesn't churn
 * the hash while real markup changes still do. Deliberately minimal in v0. */
export function normalizeDomSnapshot(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const pattern of GENERATED_ID_PATTERNS) out = out.replace(pattern, '⟨id⟩');
  return out.replace(/\s+/g, ' ').trim();
}

/** SHA-256 hex via WebCrypto — available in browsers and Node >= 20. */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Fingerprint a rendered story root (browser-side; called after storyRendered). */
export async function fingerprintElement(el: Element): Promise<string> {
  return sha256Hex(normalizeDomSnapshot(el.outerHTML));
}
