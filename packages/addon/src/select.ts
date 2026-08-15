import { TILE_ATTR } from '@igility/greenroom-shared';
import { HOVER_STYLE_ID } from './constants.js';

/**
 * Region selection on a review surface.
 *
 * Clicking a tile selects the component it shows, so the panel can scope to it. It does
 * so with capture-phase listeners on the document rather than an overlay: an overlay
 * large enough to cover the tiles also swallows the wheel, and a sheet you cannot scroll
 * is worse than one you can misclick.
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS WRONG.
 *
 * It swallowed every mousedown, mouseup and click landing anywhere in a region. The
 * reasoning was that a contact sheet is made of LIVE components, so clicking "Delete
 * account" would press it and a reviewer could trigger real behaviour believing the
 * review tool did it.
 *
 * The cost was far larger than the risk. Every control inside every tile went inert —
 * measured on a 25-region page: mousedown and click on a text input both came back
 * `defaultPrevented`, while programmatic focus still worked. So the mouse was dead and
 * the keyboard was not, which does not present as "the page is frozen"; it presents as
 * the component being broken. A reviewer clicks a field, the floating label never
 * floats, and they file a bug against the design system. On a component library the
 * specimens ARE the content, and a design review of a form means typing in it.
 *
 * So interaction wins by default, and selection takes what is left:
 *
 *   - Interactive elements are never intercepted. Click the input, use the input.
 *   - Everything else in a tile — padding, background, the name row — still selects.
 *     That is most of a tile's area, so selection stays discoverable.
 *   - Alt-click selects the region wherever it lands, including on a control. Without
 *     it, a tile whose region is filled edge to edge by one button could never be
 *     selected at all.
 *
 * The hover affordance follows exactly the same rule. Painting the outline and a
 * pointer cursor over a control would promise a click that no longer selects anything,
 * at the moment the reviewer is reaching for the control.
 *
 * Installed only when the rendered story declares regions, so a plain single-component
 * story is untouched.
 */

let teardown: (() => void) | null = null;

const regionOf = (el: EventTarget | null): HTMLElement | null =>
  el instanceof Element ? el.closest<HTMLElement>(`[${TILE_ATTR}]`) : null;

/**
 * Things a reviewer expects to operate with the mouse.
 *
 * `[tabindex]:not([tabindex="-1"])` catches the custom controls a design system builds
 * out of divs — a listbox option, a toggle — which carry no native tag but are
 * unambiguously meant to be clicked. `-1` is excluded because it means programmatically
 * focusable, not interactive, and it is common on wrappers.
 */
const INTERACTIVE =
  'a[href],button,input,select,textarea,label,summary,audio[controls],video[controls],' +
  '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],' +
  '[role="tab"],[role="menuitem"],[role="option"],[role="slider"],[role="textbox"],' +
  '[role="combobox"],[role="spinbutton"],[contenteditable=""],[contenteditable="true"],' +
  '[tabindex]:not([tabindex="-1"])';

const onInteractive = (el: EventTarget | null): boolean =>
  el instanceof Element && el.closest(INTERACTIVE) !== null;

/**
 * Whether this event should select a region rather than reach the component.
 *
 * Alt-click overrides the interactive check — that is the escape hatch for a region a
 * control fills completely. A disabled control is treated as non-interactive, because
 * nothing can happen to it and swallowing the click would leave that part of the tile
 * unselectable for no benefit.
 */
function selectionTarget(e: MouseEvent): HTMLElement | null {
  const region = regionOf(e.target);
  if (!region) return null;
  if (!e.altKey && onInteractive(e.target) && !isDisabled(e.target)) return null;
  return region;
}

const isDisabled = (el: EventTarget | null): boolean =>
  el instanceof Element &&
  (el.closest('[disabled]') !== null || el.closest('[aria-disabled="true"]') !== null);

function setHover(storyId: string | null) {
  let el = document.getElementById(HOVER_STYLE_ID);
  if (!storyId) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = HOVER_STYLE_ID;
    document.head.appendChild(el);
  }
  // `outline` rather than `border`: it paints outside the box and changes no layout,
  // so hovering a tile never nudges its neighbours.
  el.textContent =
    `[${TILE_ATTR}="${CSS.escape(storyId)}"]{outline:2px solid #2563eb;outline-offset:2px;` +
    `border-radius:2px;cursor:pointer;}`;
}

export function uninstallRegionSelection() {
  teardown?.();
  teardown = null;
  setHover(null);
}

export function installRegionSelection(onSelect: (regionStoryId: string) => void) {
  uninstallRegionSelection();

  const onOver = (e: MouseEvent) =>
    setHover(selectionTarget(e)?.getAttribute(TILE_ATTR) ?? null);
  const onLeave = () => setHover(null);

  // Swallow the press as well as the click, but only where the click would have
  // selected: without this a press on a tile's background starts a text-selection drag
  // across the sheet. A press on a control must pass through untouched, or the control
  // never takes focus and the click that follows lands on nothing.
  const swallow = (e: MouseEvent) => {
    if (!selectionTarget(e)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onClick = (e: MouseEvent) => {
    const region = selectionTarget(e);
    if (!region) return;
    e.preventDefault();
    e.stopPropagation();
    const id = region.getAttribute(TILE_ATTR);
    if (id) onSelect(id);
  };

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseleave', onLeave, true);
  document.addEventListener('mousedown', swallow, true);
  document.addEventListener('mouseup', swallow, true);
  document.addEventListener('click', onClick, true);

  teardown = () => {
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('mouseleave', onLeave, true);
    document.removeEventListener('mousedown', swallow, true);
    document.removeEventListener('mouseup', swallow, true);
    document.removeEventListener('click', onClick, true);
  };
}
