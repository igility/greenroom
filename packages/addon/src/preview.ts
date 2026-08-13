import { addons } from 'storybook/preview-api';
import { fingerprintElement, TILE_ATTR } from '@igility/greenroom-shared';
import { cancelPinMode, enterPinMode, regionsIn, storyRoot } from './capture.js';
import { installRegionSelection, uninstallRegionSelection } from './select.js';
import {
  EVENTS,
  MSG,
  STATUS_STYLE_ID,
  type CapturedPin,
  type RegionStatus,
  type RenderReport,
} from './constants.js';

let currentStoryId = '';
let currentArgs: Record<string, unknown> = {};

/** Tracks the rendered story's id + args so pin captures carry them. */
export const decorators = [
  (storyFn: () => unknown, context: { id: string; args: Record<string, unknown> }) => {
    currentStoryId = context.id;
    currentArgs = context.args;
    return storyFn();
  },
];

const channel = addons.getChannel();

// Render fingerprints go to both masters: the manager (channel) and, when this
// iframe runs inside the reviewer shell, the shell (postMessage).
channel.on('storyRendered', async (storyId: string) => {
  const root = storyRoot();
  if (!root) return;
  try {
    const hash = await fingerprintElement(root);
    const payload: RenderReport = {
      storyId: storyId ?? currentStoryId,
      hash,
      regions: await regionReport(root),
    };
    channel.emit(EVENTS.FINGERPRINT, payload);
    window.parent?.postMessage({ type: MSG.FINGERPRINT, ...payload }, '*');

    // Selection is installed only where regions were actually declared, so a plain
    // component story stays fully interactive and a review surface does not.
    if (payload.regions.length) {
      installRegionSelection((regionStoryId) =>
        window.parent?.postMessage({ type: MSG.REGION_SELECTED, regionStoryId }, '*'),
      );
    } else {
      uninstallRegionSelection();
    }
  } catch {
    // Fingerprints are an assist; never break rendering over them.
  }
});

/**
 * Hash every declared region in the rendered story.
 *
 * Nested regions are skipped: a region inside another region would have its markup
 * counted twice, and the outer hash would move whenever the inner one did, defeating
 * the point of scoping. The first declaration on a path wins.
 *
 * Duplicates are skipped too. The same story shown twice on one sheet cannot be told
 * apart afterwards, and silently letting the last one win would attach a comment to
 * whichever copy happened to render second.
 */
async function regionReport(root: HTMLElement): Promise<RenderReport['regions']> {
  const seen = new Set<string>();
  const out: RenderReport['regions'] = [];
  for (const el of regionsIn(root)) {
    const key = el.getAttribute(TILE_ATTR);
    if (!key || seen.has(key)) continue;
    if (el.parentElement?.closest(`[${TILE_ATTR}]`)) continue;
    seen.add(key);
    try {
      out.push({ regionKey: key, hash: await fingerprintElement(el) });
    } catch {
      // One unhashable region must not cost the whole report.
    }
  }
  return out;
}

/**
 * Paint review status onto declared regions.
 *
 * Done entirely through one injected stylesheet keyed by the story id, never by
 * touching the DOM: the render fingerprint is a hash of `outerHTML`, so decorating a
 * tile by inserting a badge into it would move the very hash the decoration is
 * reporting on. `outline` is used rather than `border` because it does not affect
 * layout, so nothing reflows and no neighbouring tile shifts.
 *
 * Only states that need the reviewer are drawn. On a first pass nothing is approved,
 * so every tile would carry an identical mark — noise with no signal, on exactly the
 * pass where the reviewer is scanning for defects. Settled tiles are left plain.
 */
export function paintStatus(statuses: Record<string, RegionStatus>) {
  const rules: string[] = [];
  for (const [storyId, s] of Object.entries(statuses ?? {})) {
    if (!s?.flagged) continue;
    const sel = `[${TILE_ATTR}="${CSS.escape(storyId)}"]`;
    rules.push(
      `${sel}{outline:2px solid #d4802a;outline-offset:2px;border-radius:2px;}`,
    );
  }
  let el = document.getElementById(STATUS_STYLE_ID);
  if (!rules.length) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = STATUS_STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = rules.join('\n');
}

const startCapture = (deliver: (c: CapturedPin) => void, cancelled: () => void) =>
  enterPinMode(
    (cap) =>
      deliver({
        storyId: currentStoryId,
        regionStoryId: cap.regionStoryId,
        portalCaptured: cap.portalCaptured,
        args: currentArgs,
        pin: cap.pin,
        screenshotDataUrl: cap.screenshotDataUrl,
      }),
    cancelled,
  );

// Dev mode: the manager panel drives pin mode over the Storybook channel.
channel.on(EVENTS.ENTER_PIN_MODE, () =>
  startCapture(
    (captured) => channel.emit(EVENTS.PIN_CAPTURED, captured),
    () => channel.emit(EVENTS.CANCEL_PIN_MODE),
  ),
);
channel.on(EVENTS.CANCEL_PIN_MODE, cancelPinMode);

// Review mode: the shell drives the same capture over postMessage.
window.addEventListener('message', (e: MessageEvent) => {
  const type = (e.data as { type?: string } | null)?.type;
  if (type === MSG.ENTER_PIN_MODE) {
    startCapture(
      (captured) => window.parent?.postMessage({ type: MSG.PIN_CAPTURED, captured }, '*'),
      () => window.parent?.postMessage({ type: MSG.CANCEL_PIN_MODE }, '*'),
    );
  } else if (type === MSG.CANCEL_PIN_MODE) {
    cancelPinMode();
  } else if (type === MSG.STATUS_MAP) {
    paintStatus((e.data as { statuses?: Record<string, RegionStatus> }).statuses ?? {});
  }
});

export {};
