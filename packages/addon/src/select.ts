import { TILE_ATTR } from '@igility/greenroom-shared';
import { HOVER_STYLE_ID } from './constants.js';

/**
 * Region selection on a review surface.
 *
 * A contact sheet is made of LIVE components. Clicking "Delete account" on a plain
 * page presses it — opening a confirm dialog, submitting a form, navigating away —
 * so a reviewer poking at a sheet can trigger real component behaviour and reasonably
 * believe the review tool did something. Selection therefore has to intercept.
 *
 * It does so with capture-phase listeners on the document rather than an overlay:
 * an overlay large enough to cover the tiles also swallows the wheel, and a sheet you
 * cannot scroll is worse than one you can misclick. Capture phase runs before the
 * component's own handlers, so `stopPropagation` keeps the component inert while
 * scrolling, text selection and keyboard access are untouched.
 *
 * Installed only when the rendered story actually declares regions. A plain
 * single-component story has none, so it stays fully interactive — which is what you
 * want when the thing under review IS the interaction.
 */

let teardown: (() => void) | null = null;

const regionOf = (el: EventTarget | null): HTMLElement | null =>
  el instanceof Element ? el.closest<HTMLElement>(`[${TILE_ATTR}]`) : null;

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

  const onOver = (e: Event) => setHover(regionOf(e.target)?.getAttribute(TILE_ATTR) ?? null);
  const onLeave = () => setHover(null);

  // Swallow the press as well as the click: without this the browser still focuses
  // the control underneath and paints a focus ring, which reads as "I activated
  // something" on a surface where nothing should activate.
  const swallow = (e: Event) => {
    if (!regionOf(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onClick = (e: MouseEvent) => {
    const region = regionOf(e.target);
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
