import { describe, expect, it } from 'vitest';
import { normalizeDomSnapshot, sha256Hex } from '../src/fingerprint.js';

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
