/**
 * A render fingerprint answers one question: is this the same thing the reviewer
 * approved? Since 2026-08-14 it decides whether a sign-off survives, so what it can and
 * cannot see matters more than it did when it only pre-sorted a queue.
 *
 * It hashes two things together:
 *
 *   1. The rendered markup, normalised for churn that is not a change.
 *   2. The design tokens in force — every custom property resolved on the document root.
 *
 * The second exists because markup alone gets this backwards. In a token-driven system
 * the class string stays `text-primary` while the colour behind it changes, so retuning
 * the brand primary across every component is invisible, while swapping one utility on
 * one component is caught. The cheap change is detected and the consequential one is
 * not. Reading the root's custom properties costs one getComputedStyle per render — not
 * a walk of the subtree — and closes exactly the class of change a design-system review
 * exists to judge.
 *
 * Still blind: CSS not expressed as a token (a hand-written selector, a hover state
 * defined outside the system), an image or font swapped behind an unchanged reference,
 * and behaviour of any kind. A fingerprint sees a rendered still, not a component.
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

/**
 * The design tokens in force, as a stable string.
 *
 * Sorted, because the order custom properties enumerate in is not contractual and a
 * reordering is not a change. Values are read resolved, so a role pointing at a
 * different raw token registers even when neither name moved.
 */
export function tokenSnapshot(doc: Document | null | undefined): string {
  const view = doc?.defaultView;
  if (!doc || !view) return '';
  const cs = view.getComputedStyle(doc.documentElement);
  const names: string[] = [];
  for (let i = 0; i < cs.length; i++) {
    const name = cs.item(i);
    if (name.startsWith('--')) names.push(name);
  }
  return names
    .sort()
    .map((n) => `${n}:${cs.getPropertyValue(n).trim()}`)
    .join(';');
}

/** Fingerprint a rendered story root (browser-side; called after storyRendered). */
export async function fingerprintElement(el: Element): Promise<string> {
  // NUL-separated so markup ending in what looks like a token declaration cannot be
  // confused with the token section beginning.
  return sha256Hex(`${normalizeDomSnapshot(el.outerHTML)}\u0000${tokenSnapshot(el.ownerDocument)}`);
}
