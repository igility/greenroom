import { finder } from '@medv/finder';
import { domToPng } from 'modern-screenshot';
import { ANCHOR_ATTR, TILE_SELECTOR, TILE_ATTR, type Pin } from '@igility/greenroom-shared';
import { STATUS_STYLE_ID } from './constants.js';

export interface Capture {
  pin: Pin;
  screenshotDataUrl: string | null;
  /**
   * The declared region the click landed in — the story id from the host's
   * `data-greenroom-story` attribute — or null when the click was on undeclared
   * markup (a heading, the gap between tiles, a plain single-component story).
   */
  regionStoryId: string | null;
  /**
   * True when the target rendered outside the story root entirely — a popover,
   * modal or listbox portalled to document.body. The screenshot is then a viewport
   * capture rather than an element render, because an element render of the tile
   * would show the trigger in its closed state: a plausible, confident picture of
   * the wrong thing, which is worse evidence than an obviously unhelpful one.
   */
  portalCaptured: boolean;
}

/**
 * What `finder` is allowed to build a selector out of.
 *
 * It accepts only role, name, aria-label, rel and href by default, so a list of cards
 * carrying none of those falls back to a positional path — `ol:nth-child(4) >
 * li:nth-of-type(8) > .flex > div`. That is correct exactly until the list is reordered,
 * and then it resolves to a different card while the comment still claims to be about
 * the first one.
 *
 * Letting the host's declared anchor in fixes that at the source: an anchor means the
 * same thing next week, wherever the element has moved to.
 */
export const selectorOptions = { attr: (name: string) => name === ANCHOR_ATTR };

let overlay: HTMLDivElement | null = null;
let escListener: ((e: KeyboardEvent) => void) | null = null;

export function cancelPinMode() {
  overlay?.remove();
  overlay = null;
  if (escListener) {
    window.removeEventListener('keydown', escListener);
    escListener = null;
  }
}

/** The nearest ancestor (or self) the host has declared as representing a story. */
export function regionOf(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>(TILE_SELECTOR);
}

/** Every declared region inside a rendered story, in document order. */
/**
 * What the screenshot should actually show.
 *
 * A declared tile when the click landed in one. Otherwise the element clicked — not the
 * whole story root, which is what this used to fall back to. On any page that is not a
 * contact sheet, that fallback produced a picture of the entire page: on a style tile or
 * a long layout the thing being discussed is a few unreadable pixels somewhere in it, and
 * the reviewer's own comment stops being evidence of anything.
 *
 * A clicked element can be smaller than its own meaning — a label, an icon, a single
 * character of help text — so climb until the frame is big enough to recognise. The
 * thresholds are deliberately small: the point is to include enough context to identify
 * the thing, not to widen back out to the page.
 */
const MIN_SHOT_W = 96;
const MIN_SHOT_H = 48;

export function shotElement(
  el: Element | null,
  region: HTMLElement | null,
  root: HTMLElement | null,
): HTMLElement | null {
  if (region) return region;
  if (!(el instanceof HTMLElement)) return root;
  let node: HTMLElement | null = el;
  while (node && node !== root) {
    const rect = node.getBoundingClientRect();
    if (rect.width >= MIN_SHOT_W && rect.height >= MIN_SHOT_H) return node;
    if (!node.parentElement) break;
    node = node.parentElement;
  }
  return node ?? root;
}

export function regionsIn(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TILE_SELECTOR));
}

/**
 * Cover the story with a crosshair layer; one click captures the region it landed in,
 * a region-relative selector, position, viewport, and a screenshot.
 *
 * Scoping both the selector and the screenshot to the region is what makes a contact
 * sheet reviewable. A selector generated against the whole sheet degrades to a deep
 * positional path once thirty near-identical controls are on the page, and re-points at
 * a different tile the moment the grid is reordered; a screenshot of the whole sheet
 * leaves an agent thirty components to guess between. Esc cancels.
 */
export function enterPinMode(onCapture: (c: Capture) => void, onCancel?: () => void) {
  if (overlay) return;

  overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483000;cursor:crosshair;background:rgba(37,99,235,0.06);';
  const banner = document.createElement('div');
  banner.textContent = 'Click what you want to comment on — Esc to cancel';
  banner.style.cssText =
    'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#1f2430;color:#fff;' +
    'font:600 12px/1 system-ui;padding:8px 14px;border-radius:999px;pointer-events:none;';
  overlay.appendChild(banner);

  escListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      cancelPinMode();
      onCancel?.();
    }
  };
  window.addEventListener('keydown', escListener);

  overlay.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const target = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((el) => el !== overlay && !overlay!.contains(el));

    const root = storyRoot();
    const el = target instanceof Element && target !== document.body ? target : null;
    const region = el ? regionOf(el) : null;
    // Portalled overlays render to document.body, outside the story root and outside
    // any region. Detect it rather than letting the selector silently degrade.
    const portalCaptured = !!el && !!root && !root.contains(el);

    // Anchor the selector to the region when there is one: region-relative selectors
    // stay short and stable while the surrounding grid changes around them.
    const selectorRoot = region ?? root ?? document.body;
    let selector = 'body';
    if (el) {
      try {
        selector = finder(el, {
          ...selectorOptions,
          root: selectorRoot,
        });
      } catch {
        selector = el.tagName.toLowerCase();
      }
    }

    const pin: Pin = {
      selector,
      x: e.clientX,
      y: e.clientY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      // The preview knows how wide it is; only the manager knows what the reviewer
      // SELECTED, so the panel fills this in at submit time. Null here is honest rather
      // than a placeholder — a surface with no viewport control leaves it null.
      viewportLabel: null,
    };

    // Remove the overlay before screenshotting so the capture is clean.
    cancelPinMode();

    // Render the region itself rather than rasterising the whole root and cropping.
    // Storybook clips the story root to max-height:100vh and modern-screenshot does not
    // restore scroll position by default, so on a scrolled sheet a crop of the root is
    // taken from a render of the TOP of the sheet — the wrong component, confidently
    // framed. Rendering the element directly also cuts the image size and the latency.
    // Status decoration is review chrome, not the design. Suppress it for the shot so
    // the evidence shows the component exactly as the client's users will see it.
    const paint = document.getElementById(STATUS_STYLE_ID);
    const keptPaint = paint?.textContent ?? null;
    if (paint) paint.textContent = '';

    const shotTarget = portalCaptured ? null : shotElement(el, region, root);
    let screenshotDataUrl: string | null = null;
    if (shotTarget) {
      try {
        screenshotDataUrl = await domToPng(shotTarget);
      } catch {
        screenshotDataUrl = null;
      }
    }
    if (paint && keptPaint !== null) paint.textContent = keptPaint;

    onCapture({
      pin,
      screenshotDataUrl,
      regionStoryId: region?.getAttribute(TILE_ATTR) || null,
      portalCaptured,
    });
  });

  document.body.appendChild(overlay);
}

export function storyRoot(): HTMLElement | null {
  return document.getElementById('storybook-root');
}
