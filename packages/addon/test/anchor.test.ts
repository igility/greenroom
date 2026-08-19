// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { finder } from '@medv/finder';
import { ANCHOR_ATTR } from '@igility/greenroom-shared';
import { selectorOptions } from '../src/capture.js';

/**
 * Comments on a list of cards were getting positional selectors, because the markup gave
 * `finder` nothing else to build from. Reorder the list — which happens every time a
 * decision is answered and sorts to the bottom — and the selector resolves to a
 * different card. The comment is not lost, it is mis-pointed, which is worse: "show me"
 * scrolls to the wrong decision while the screenshot still shows the right one.
 */

/** A decisions list, as the host renders it: cards with no id, no role, nothing
 *  distinguishing but their position. */
function decisions(order: string[], withAnchors: boolean) {
  document.body.innerHTML = `<div id="root"><ol>${order
    .map(
      (q) =>
        `<li ${withAnchors ? `${ANCHOR_ATTR}="${q}"` : ''} class="rounded-card">` +
        `<div class="flex"><div><p>${q}</p></div></div></li>`,
    )
    .join('')}</ol></div>`;
  return document.getElementById('root') as HTMLElement;
}

const cardFor = (root: HTMLElement, q: string) =>
  [...root.querySelectorAll('li')].find((li) => li.textContent === q)!.querySelector('.flex')!;

describe('pinning a comment to a card', () => {
  it('produces a positional selector when the host declares no anchor', () => {
    // The behaviour that caused this. Recorded so the fix is not mistaken for the
    // default, and so the cost of a host declaring nothing stays visible.
    const root = decisions(['icons', 'colour', 'progress'], false);
    const selector = finder(cardFor(root, 'progress'), { ...selectorOptions, root });
    expect(selector).toMatch(/nth-/);
  });

  it('follows the card when the list is reordered, given an anchor', () => {
    const before = decisions(['icons', 'colour', 'progress'], true);
    const selector = finder(cardFor(before, 'progress'), { ...selectorOptions, root: before });
    expect(selector).toContain(ANCHOR_ATTR);
    expect(selector).not.toMatch(/nth-/);

    // A decision gets answered and sorts to the bottom; two others move up.
    const after = decisions(['progress', 'icons', 'colour'], true);
    const landed = after.querySelector(selector);
    expect(landed).not.toBeNull();
    // Still the same card, not whatever now occupies the old position.
    expect(landed!.textContent).toContain('progress');
  });

  it('lands on the wrong card after a reorder when there is no anchor', () => {
    // The failure this exists to prevent, demonstrated rather than described.
    const before = decisions(['icons', 'colour', 'progress'], false);
    const selector = finder(cardFor(before, 'progress'), { ...selectorOptions, root: before });

    const after = decisions(['progress', 'icons', 'colour'], false);
    const landed = after.querySelector(selector);
    expect(landed).not.toBeNull();
    expect(landed!.textContent).not.toContain('progress');
  });
});
