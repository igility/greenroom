import { finder } from '@medv/finder';
import { domToPng } from 'modern-screenshot';
import type { Pin } from '@greenroom/shared';

export interface Capture {
  pin: Pin;
  screenshotDataUrl: string | null;
}

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

/** Cover the story with a crosshair layer; one click captures selector, position,
 * viewport, and a DOM screenshot of the story root. Esc cancels. */
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

    let selector = 'body';
    if (target instanceof Element && target !== document.body) {
      try {
        selector = finder(target, { root: storyRoot() ?? document.body });
      } catch {
        selector = target.tagName.toLowerCase();
      }
    }

    const pin: Pin = {
      selector,
      x: e.clientX,
      y: e.clientY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };

    // Remove the overlay before screenshotting so the capture is clean.
    cancelPinMode();

    let screenshotDataUrl: string | null = null;
    try {
      screenshotDataUrl = await domToPng(storyRoot() ?? document.body);
    } catch {
      screenshotDataUrl = null;
    }

    onCapture({ pin, screenshotDataUrl });
  });

  document.body.appendChild(overlay);
}

export function storyRoot(): HTMLElement | null {
  return document.getElementById('storybook-root');
}
