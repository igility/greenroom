/**
 * The host-Storybook contract.
 *
 * Greenroom knows nothing about how a design system is organised — no notion of a
 * "form element", no taxonomy, no required page structure. A Storybook opts a region
 * of a rendered story into tile-level review by emitting ONE attribute:
 *
 *   <div data-greenroom-story="components-forms-phonefield--default"> … </div>
 *
 * Emit it and that region becomes independently commentable, fingerprintable and
 * status-decorated. Emit nothing and every story behaves exactly as it did before.
 *
 * This is deliberately not a contact-sheet feature. A page-layout story that labels
 * its own header and footer gets the same behaviour with no grid involved.
 *
 * Generation tooling that scaffolds conforming Storybooks is a SEPARATE, OPTIONAL
 * surface. Nothing in the review path may depend on it: a hand-authored Storybook
 * that emits the attribute must behave identically to a generated one.
 */

/** Marks an element as representing another story. Value is that story's id. */
export const TILE_ATTR = 'data-greenroom-story';

/** CSS selector for every declared region inside a rendered story. */
export const TILE_SELECTOR = `[${TILE_ATTR}]`;

/**
 * Story tag declaring a contact sheet: a navigation and batch surface that surveys
 * other stories. A sheet is never a review unit in its own right — it is excluded
 * from approval, from progress counts, and from the agent's work queue, and its
 * status is a rollup over its members.
 *
 * Storybook carries tags into index.json, so this needs no separate manifest.
 */
export const SHEET_TAG = 'greenroom:sheet';

/**
 * Region key for the story root itself, distinguishing the whole-story fingerprint
 * from per-region ones in the same table. Empty string sorts first and keeps
 * pre-existing rows meaningful after migration.
 */
export const ROOT_REGION = '';

/**
 * Attribute a host puts on anything a comment should stay attached to across edits.
 *
 * Without it, a pin's selector is whatever `finder` could construct from the markup —
 * and on a list of cards with no ids, classes or roles to grab, that is a positional
 * path like `ol:nth-child(4) > li:nth-of-type(8) > .flex > div`. Reorder the list and
 * that selector silently resolves to a DIFFERENT card. The comment is not lost; it is
 * mis-pointed, which is worse, because "show me" scrolls to the wrong thing while the
 * screenshot still shows the right one.
 *
 * The value only has to be stable and unique within the story. A slug of the thing's
 * own identity is ideal — the question a decision card asks, the name of a token — since
 * that survives reordering, restyling and re-statusing. It is NOT a story id, which is
 * what `data-greenroom-story` is for: a tile declares "I am this story", an anchor
 * declares "I am this thing, wherever I end up".
 *
 * Optional. A host that sets nothing keeps working exactly as before.
 */
export const ANCHOR_ATTR = 'data-greenroom-anchor';
