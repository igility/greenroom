// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TILE_ATTR } from '@igility/greenroom-shared';
import { installRegionSelection, uninstallRegionSelection } from '../src/select.js';
import { HOVER_STYLE_ID } from '../src/constants.js';

/**
 * A contact sheet tile as the host actually builds one: the attribute sits on the OUTER
 * card, so the region covers the live specimen AND its name row. That is deliberate on
 * the host side — bigger click target, an outline matching what the reviewer thinks they
 * are commenting on, and the component name inside the screenshot that travels with the
 * comment. It is also exactly what made every control inside inert.
 */
function sheet() {
  document.body.innerHTML = `
    <div id="storybook-root">
      <div ${TILE_ATTR}="components-forms-textfield--default" id="tile">
        <div class="specimen">
          <label for="field" id="lab">Email</label>
          <input id="field" type="text" />
          <button id="btn">Save</button>
          <button id="off" disabled>Archive</button>
          <div id="custom" role="switch" tabindex="0">Notify me</div>
        </div>
        <div class="name-row" id="chrome">TextField</div>
      </div>
      <p id="outside">not in any region</p>
    </div>`;
}

/** Returns true when the event reached the component — i.e. nothing swallowed it. */
const send = (el: Element, type: string, init: MouseEventInit = {}): boolean =>
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));

const $ = (id: string) => document.getElementById(id)!;

let selected: string[];

beforeEach(() => {
  sheet();
  selected = [];
  installRegionSelection((id) => selected.push(id));
});

afterEach(() => {
  uninstallRegionSelection();
  vi.restoreAllMocks();
});

describe('region selection leaves the specimen usable', () => {
  // The report's measurement, turned into a test: on a 25-region page a mousedown and a
  // click dispatched to an input inside a region both came back delivered:false, while
  // programmatic focus worked. Mouse dead, keyboard alive — which reads as a broken
  // component rather than a frozen page, and took a while to trace back to the addon.
  it('delivers mousedown, mouseup and click to a text input inside a region', () => {
    expect(send($('field'), 'mousedown')).toBe(true);
    expect(send($('field'), 'mouseup')).toBe(true);
    expect(send($('field'), 'click')).toBe(true);
    expect(selected).toEqual([]);
  });

  it('delivers a click to a button inside a region', () => {
    const pressed = vi.fn();
    $('btn').addEventListener('click', pressed);
    expect(send($('btn'), 'click')).toBe(true);
    expect(pressed).toHaveBeenCalledOnce();
    expect(selected).toEqual([]);
  });

  it('delivers a click to a label, so it still focuses its control', () => {
    expect(send($('lab'), 'click')).toBe(true);
    expect(selected).toEqual([]);
  });

  it('delivers a click to a custom control built from a div', () => {
    // A design system's switch or listbox option has no native tag. Missing these would
    // leave exactly the bespoke components a review is most about still inert.
    expect(send($('custom'), 'click')).toBe(true);
    expect(selected).toEqual([]);
  });
});

describe('region selection still selects', () => {
  it('selects when the click lands on a tile’s own chrome', () => {
    expect(send($('chrome'), 'click')).toBe(false);
    expect(selected).toEqual(['components-forms-textfield--default']);
  });

  it('selects on alt-click even when the click lands on a control', () => {
    // The escape hatch: without it a region filled edge to edge by one control could
    // never be selected at all.
    expect(send($('field'), 'click', { altKey: true })).toBe(false);
    expect(selected).toEqual(['components-forms-textfield--default']);
  });

  it('selects on a disabled control, which can do nothing anyway', () => {
    expect(send($('off'), 'click')).toBe(false);
    expect(selected).toEqual(['components-forms-textfield--default']);
  });

  it('ignores clicks outside every region', () => {
    expect(send($('outside'), 'click')).toBe(true);
    expect(selected).toEqual([]);
  });

  it('stops intercepting once uninstalled', () => {
    uninstallRegionSelection();
    expect(send($('chrome'), 'click')).toBe(true);
    expect(selected).toEqual([]);
  });
});

describe('the hover affordance promises only what a click will do', () => {
  const hoverCss = () => document.getElementById(HOVER_STYLE_ID)?.textContent ?? '';

  it('paints the tile when the pointer is over selectable chrome', () => {
    send($('chrome'), 'mouseover');
    expect(hoverCss()).toContain('components-forms-textfield--default');
    expect(hoverCss()).toContain('cursor:pointer');
  });

  it('paints nothing when the pointer is over a control', () => {
    // Otherwise the outline and the pointer cursor say "click to select" at the exact
    // moment the reviewer is reaching for the field.
    send($('field'), 'mouseover');
    expect(hoverCss()).toBe('');
  });

  it('paints over a control while alt is held, matching what alt-click does', () => {
    send($('field'), 'mouseover', { altKey: true });
    expect(hoverCss()).toContain('components-forms-textfield--default');
  });
});
