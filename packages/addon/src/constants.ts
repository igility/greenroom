import type { Pin } from '@greenroom/shared';

export const ADDON_ID = 'greenroom';
export const PANEL_ID = `${ADDON_ID}/panel`;
export const PARAM_KEY = 'greenroom';

/** Storybook channel events (manager ↔ preview, dev mode). */
export const EVENTS = {
  ENTER_PIN_MODE: `${ADDON_ID}/enter-pin-mode`,
  CANCEL_PIN_MODE: `${ADDON_ID}/cancel-pin-mode`,
  PIN_CAPTURED: `${ADDON_ID}/pin-captured`,
  FINGERPRINT: `${ADDON_ID}/fingerprint`,
} as const;

/** postMessage types (reviewer shell ↔ story iframe, review mode). */
export const MSG = {
  ENTER_PIN_MODE: 'greenroom:enter-pin-mode',
  CANCEL_PIN_MODE: 'greenroom:cancel-pin-mode',
  PIN_CAPTURED: 'greenroom:pin-captured',
  FINGERPRINT: 'greenroom:fingerprint',
} as const;

export interface CapturedPin {
  storyId: string;
  pin: Pin;
  args: Record<string, unknown>;
  screenshotDataUrl: string | null;
}
