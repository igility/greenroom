import { addons } from 'storybook/preview-api';
import { fingerprintElement } from '@greenroom/shared';
import { cancelPinMode, enterPinMode, storyRoot } from './capture.js';
import { EVENTS, MSG, type CapturedPin } from './constants.js';

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
    const payload = { storyId: storyId ?? currentStoryId, hash };
    channel.emit(EVENTS.FINGERPRINT, payload);
    window.parent?.postMessage({ type: MSG.FINGERPRINT, ...payload }, '*');
  } catch {
    // Fingerprints are an assist; never break rendering over them.
  }
});

const startCapture = (deliver: (c: CapturedPin) => void, cancelled: () => void) =>
  enterPinMode(
    (cap) =>
      deliver({
        storyId: currentStoryId,
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
  }
});

export {};
