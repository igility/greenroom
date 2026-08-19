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
 * The value only has to be stable and unique within the story. It is NOT a story id,
 * which is what `data-greenroom-story` is for: a tile declares "I am this story", an
 * anchor declares "I am this thing, wherever I end up".
 *
 * 🔴 DECLARE THE VALUE. DO NOT DERIVE IT FROM THE TEXT.
 *
 * An earlier version of this note recommended slugging the thing's own words — the
 * question a decision card asks, the name of a token — on the reasoning that an
 * identifier is not something a reviewer sees. That advice was taken, and it was wrong
 * in a specific way: it survives the edit it was tested against and fails the edit that
 * actually happens.
 *
 *   reordering the list      → text unchanged → anchor holds   ✅ (what it was built for)
 *   changing a card's status → text unchanged → anchor holds   ✅
 *   REWORDING the card       → slug changes   → comment orphans ❌
 *   DELETING the card        → anchor vanishes → comment orphans, silently ❌
 *
 * On a review surface the whole point of which is that decisions get revised, rewording
 * is not an edge case: it is the main verb. A derived anchor therefore breaks precisely
 * when the review is working. Give each item a declared id and both problems go: the
 * words become free to change, and a missing id becomes detectable rather than silent.
 *
 * Seed the declared ids with whatever the derivation currently produces if comments
 * already exist — the anchors are then unchanged and nothing needs re-anchoring.
 *
 * Optional. A host that sets nothing keeps working exactly as before.
 */
export const ANCHOR_ATTR = 'data-greenroom-anchor';

/**
 * Optional build manifest naming every anchor the build contains, written to the root of
 * `storybook-static` as `greenroom-anchors.json`:
 *
 *   { "anchors": { "<storyId>": ["decision-radius", "decision-offer-timing"] } }
 *
 * Anchors are produced at RENDER time, so an uploaded archive cannot be asked what it
 * contains without executing it. This is how a host answers that question statically.
 *
 * What it buys: an upload can be refused when an anchor carrying open client comments
 * has disappeared from the build. Without it, deleting a commented item is invisible —
 * the story survives, so the story-level check sees nothing, and the comment simply
 * stops resolving with nobody informed.
 *
 * Optional, and absent means only that this check does not run. Never a hard requirement:
 * a hand-authored Storybook that emits nothing must keep working.
 */
export const ANCHOR_MANIFEST_FILE = 'greenroom-anchors.json';

/** Shape of that file. */
export interface AnchorManifest {
  anchors: Record<string, string[]>;
}
