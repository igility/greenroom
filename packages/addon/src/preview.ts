import { addons } from 'storybook/preview-api';
import { fingerprintElement, TILE_ATTR } from '@igility/greenroom-shared';
import { cancelPinMode, enterPinMode, regionsIn, storyRoot } from './capture.js';
import { installRegionSelection, uninstallRegionSelection } from './select.js';
import {
  EVENTS,
  MSG,
  STATUS_STYLE_ID,
  REVEAL_STYLE_ID,
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
      // Both masters: the shell over postMessage, the manager panel over the channel.
      // Selection was always computed here; only the shell was ever told about it, which
      // is why a tile could be commented on from the panel but never acted on.
      installRegionSelection((regionStoryId) => {
        window.parent?.postMessage({ type: MSG.REGION_SELECTED, regionStoryId }, '*');
        channel.emit(EVENTS.REGION_SELECTED, regionStoryId);
      });
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
const STATE_OUTLINE = {
  /** Needs the reviewer. Warm and the most visible of the three. */
  flagged: '#d4802a',
  /** Approved and unchanged since. Green: the state the reviewer is working towards. */
  settled: '#3f8f5f',
  /** Said, and answered, but not yet signed off. Quiet — history, not a task. */
  resolved: '#9aa3ad',
} as const;

/** The last statuses received, kept whether or not they are being painted, so revealing
 *  a tile can speak in the same colour the status would — even with the paint switched
 *  off. One source of truth for "what state is this in". */
let knownStatuses: Record<string, RegionStatus> = {};

export function rememberStatuses(statuses: Record<string, RegionStatus>) {
  knownStatuses = statuses ?? {};
}

const colourOf = (s?: RegionStatus | null): string | null =>
  !s
    ? null
    : s.flagged
      ? STATE_OUTLINE.flagged
      : s.settled
        ? STATE_OUTLINE.settled
        : s.resolved
          ? STATE_OUTLINE.resolved
          : null;

/** The colour a region's state earns it, or null when it has no state worth a colour. */
function statusColour(regionStoryId: string): string | null {
  const s = knownStatuses[regionStoryId];
  if (!s) return null;
  return s.flagged
    ? STATE_OUTLINE.flagged
    : s.settled
      ? STATE_OUTLINE.settled
      : s.resolved
        ? STATE_OUTLINE.resolved
        : null;
}

const rgba = (hex: string, alpha: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

/** What "you are working on this one" looks like. Deliberately not one of the status
 *  colours: selection is about attention, not about state, and a tile keeps its state
 *  while you have it selected. */
const SELECTED_OUTLINE = '#2563eb';

export function paintStatus(statuses: Record<string, RegionStatus>, selected?: string | null) {
  const rules: string[] = [];
  for (const [storyId, s] of Object.entries(statuses ?? {})) {
    // Order is priority, not preference: something open outranks a sign-off, and a
    // sign-off outranks a thread that was merely answered.
    const colour = s?.flagged
      ? STATE_OUTLINE.flagged
      : s?.settled
        ? STATE_OUTLINE.settled
        : s?.resolved
          ? STATE_OUTLINE.resolved
          : null;
    if (!colour || storyId === selected) continue;
    const sel = `[${TILE_ATTR}="${CSS.escape(storyId)}"]`;
    rules.push(
      `${sel}{outline:2px solid ${colour};outline-offset:2px;border-radius:2px;}`,
    );
  }
  // Selection is drawn last and a shade heavier, so it reads as the active one whatever
  // state it is in. Its status returns the moment it is deselected — the colour is
  // borrowed for the duration of the interaction, not overwritten.
  if (selected) {
    rules.push(
      `[${TILE_ATTR}="${CSS.escape(selected)}"]{outline:3px solid ${SELECTED_OUTLINE};` +
        `outline-offset:2px;border-radius:2px;}`,
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


/**
 * Answer "where is the thing I just clicked in the list".
 *
 * Scrolls the region into view and throbs its outline for a couple of seconds. Uses its
 * own stylesheet so it works whether or not status paint is switched on, and so expiring
 * it never disturbs what the reviewer chose to leave showing. Like status paint it only
 * ever adds a rule — the DOM is not touched, because the fingerprint hashes outerHTML.
 */
export function revealRegion(regionStoryId: string, hinted?: RegionStatus | null) {
  const sel = `[${TILE_ATTR}="${CSS.escape(regionStoryId)}"]`;
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });

  let sheet = document.getElementById(REVEAL_STYLE_ID);
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = REVEAL_STYLE_ID;
    document.head.appendChild(sheet);
  }
  // A soft halo that fades in, fans outward and decays slowly — enough to catch the eye
  // travelling down a sheet without the hard strobe of a flashing outline. box-shadow is
  // used rather than outline for the same reason status paint avoids borders: it paints
  // outside the box and moves nothing, so no neighbouring tile shifts.
  // Speak in the tile's own status colour where it has one, so the halo and the outline
  // are one signal rather than two. Neutral blue only when the tile has no state to
  // report — nothing said about it, nothing settled.
  // The hint is carried by the reveal itself, because the alternative loses a race: the
  // status map arrives on a fetch while the reveal fires on a timer, so revealing a tile
  // just after navigating to its surface would colour it neutral even though it is
  // flagged. Fall back to what we know, then to neutral.
  const base = colourOf(hinted) ?? statusColour(regionStoryId) ?? '#2563eb';
  sheet.textContent =
    `@keyframes greenroom-reveal{` +
    `0%{box-shadow:0 0 0 0 ${rgba(base, 0)},0 0 0 0 ${rgba(base, 0)}}` +
    `18%{box-shadow:0 0 0 3px ${rgba(base, 0.4)},0 0 14px 5px ${rgba(base, 0.26)}}` +
    `100%{box-shadow:0 0 0 16px ${rgba(base, 0)},0 0 40px 22px ${rgba(base, 0)}}}` +
    `${sel}{animation:greenroom-reveal 1.9s cubic-bezier(.16,.84,.44,1) 2;}`;

  window.setTimeout(() => {
    if (document.getElementById(REVEAL_STYLE_ID) === sheet) sheet.textContent = '';
  }, 4200);
  return true;
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
// Dev/manager mode: the panel drives status paint and reveal over the same channel the
// shell drives them over postMessage, so both surfaces behave identically.
channel.on(
  EVENTS.STATUS_MAP,
  (payload: {
    statuses?: Record<string, RegionStatus>;
    paint?: boolean;
    selected?: string | null;
  }) => {
    rememberStatuses(payload?.statuses ?? {});
    // Selection is drawn even with status paint off: it answers "which one am I acting
    // on", which the reviewer needs regardless of whether they asked to see state.
    paintStatus(payload?.paint === false ? {} : (payload?.statuses ?? {}), payload?.selected);
  },
);
channel.on(
  EVENTS.REVEAL_REGION,
  (payload: string | { regionStoryId: string; status?: RegionStatus | null }) =>
    typeof payload === 'string'
      ? revealRegion(payload)
      : revealRegion(payload.regionStoryId, payload.status),
);

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
    const statuses = (e.data as { statuses?: Record<string, RegionStatus> }).statuses ?? {};
    rememberStatuses(statuses);
    paintStatus(statuses);
  }
});

export {};
