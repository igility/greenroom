import { describe, expect, it } from 'vitest';
import { normalizeDomSnapshot, sha256Hex, tokenSnapshot } from '../src/fingerprint.js';

/** Minimal stand-in for the one browser API tokenSnapshot uses. */
function docWithTokens(tokens: Record<string, string>): Document {
  const names = Object.keys(tokens);
  const cs = {
    length: names.length,
    item: (i: number) => names[i] ?? '',
    getPropertyValue: (n: string) => tokens[n] ?? '',
  };
  return {
    documentElement: {},
    defaultView: { getComputedStyle: () => cs },
  } as unknown as Document;
}

describe('normalizeDomSnapshot', () => {
  it('ignores comments, whitespace runs, and React useId churn', () => {
    const a = normalizeDomSnapshot(
      '<div id=":r1:">  <!-- hydration marker -->\n  <span id="«r7»">Hi</span></div>',
    );
    const b = normalizeDomSnapshot('<div id=":r9:"> <span id="«r2»">Hi</span></div>');
    expect(a).toBe(b);
  });

  it('still changes when real markup changes', () => {
    const a = normalizeDomSnapshot('<button class="primary">Save</button>');
    const b = normalizeDomSnapshot('<button class="secondary">Save</button>');
    expect(a).not.toBe(b);
  });
});

describe('sha256Hex', () => {
  it('produces a stable 64-char hex digest', async () => {
    const h = await sha256Hex('greenroom');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex('greenroom')).toBe(h);
  });
});

describe('tokenSnapshot', () => {
  it('captures the design tokens in force, order-independently', () => {
    const a = docWithTokens({ '--fg': '#242424', '--primary': '#1a4940' });
    const b = docWithTokens({ '--primary': '#1a4940', '--fg': '#242424' });
    // Enumeration order is not contractual, and a reordering is not a change.
    expect(tokenSnapshot(a)).toBe(tokenSnapshot(b));
    expect(tokenSnapshot(a)).toContain('--primary:#1a4940');
  });

  it('changes when a token value changes, which markup alone cannot see', () => {
    // The class stays `text-primary` either way — this is the whole reason the token
    // layer is hashed. Retuning the brand primary must not slip past an approval.
    const before = docWithTokens({ '--primary': '#1a4940' });
    const after = docWithTokens({ '--primary': '#a21d49' });
    expect(tokenSnapshot(before)).not.toBe(tokenSnapshot(after));
  });

  it('ignores properties that are not custom properties', () => {
    const d = docWithTokens({ '--primary': '#1a4940', color: 'red' });
    expect(tokenSnapshot(d)).toBe('--primary:#1a4940');
  });

  it('is empty rather than throwing outside a browser', () => {
    expect(tokenSnapshot(null)).toBe('');
    expect(tokenSnapshot({ defaultView: null } as unknown as Document)).toBe('');
  });
});
