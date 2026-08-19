import type { Pin } from '@igility/greenroom-shared';

export const ADDON_ID = 'greenroom';
export const PANEL_ID = `${ADDON_ID}/panel`;
export const PARAM_KEY = 'greenroom';

/** Storybook channel events (manager ↔ preview, dev mode). */
export const EVENTS = {
  ENTER_PIN_MODE: `${ADDON_ID}/enter-pin-mode`,
  CANCEL_PIN_MODE: `${ADDON_ID}/cancel-pin-mode`,
  PIN_CAPTURED: `${ADDON_ID}/pin-captured`,
  FINGERPRINT: `${ADDON_ID}/fingerprint`,
  STATUS_MAP: `${ADDON_ID}/status-map`,
  REVEAL_REGION: `${ADDON_ID}/reveal-region`,
  /** Preview's answer to a reveal: did the thing actually turn out to be there. */
  REVEAL_RESULT: `${ADDON_ID}/reveal-result`,
  REGION_SELECTED: `${ADDON_ID}/region-selected`,
} as const;

/** postMessage types (reviewer shell ↔ story iframe, review mode). */
export const MSG = {
  ENTER_PIN_MODE: 'greenroom:enter-pin-mode',
  CANCEL_PIN_MODE: 'greenroom:cancel-pin-mode',
  PIN_CAPTURED: 'greenroom:pin-captured',
  FINGERPRINT: 'greenroom:fingerprint',
  STATUS_MAP: 'greenroom:status-map',
  REGION_SELECTED: 'greenroom:region-selected',
  REVEAL_REGION: 'greenroom:reveal-region',
  REVEAL_RESULT: 'greenroom:reveal-result',
} as const;

/** The single injected stylesheet that paints review status onto declared regions. */
export const STATUS_STYLE_ID = 'greenroom-status-style';

/** Separate sheet for the transient hover outline, so it never clobbers status paint. */
export const HOVER_STYLE_ID = 'greenroom-hover-style';

/** Separate sheet again for the throb that answers "where is the thing I just clicked".
 *  Kept apart from status paint so revealing works whether or not status is switched on,
 *  and so it can expire without disturbing what the reviewer chose to leave showing. */
export const REVEAL_STYLE_ID = 'greenroom-reveal-style';

/** Per-region review status, sent by the shell so tiles can show where they stand. */
export interface RegionStatus {
  /** Any open comment on this component, wherever it was raised. */
  flagged?: boolean;
  /** Every comment on it has been resolved. */
  resolved?: boolean;
  /** Settled: approved, and unchanged since. */
  settled?: boolean;
}

export interface CapturedPin {
  /** The story that was rendered — for a contact sheet, the sheet itself. */
  storyId: string;
  /**
   * The declared region the click landed in, or null. This is what the comment is
   * ultimately attributed to; `storyId` is retained as where the reviewer was
   * standing when they said it.
   */
  regionStoryId: string | null;
  /** The target rendered outside the story root (a portalled popover/modal/listbox). */
  portalCaptured: boolean;
  pin: Pin;
  args: Record<string, unknown>;
  screenshotDataUrl: string | null;
}

/**
 * What one render observed: the story's own hash plus a hash per declared region.
 *
 * Both come from a single traversal because they answer the same question — what does
 * this surface show, and has any of it moved. Per-region hashes are what let a second
 * review round present only the tiles that actually changed; a single whole-story hash
 * reports a sheet as changed the moment any one of thirty tiles does.
 */
export interface RenderReport {
  storyId: string;
  hash: string;
  regions: { regionKey: string; hash: string }[];
}
