import { describe, expect, it } from 'vitest';
import { withStaleBuildNotice } from '../src/util.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const page = (body = '<div id="root"></div>') =>
  enc(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`);

describe('withStaleBuildNotice', () => {
  it('inserts the bar before </body> and leaves the document otherwise intact', () => {
    const out = dec(withStaleBuildNotice(page(), 'build-2'));
    expect(out).toContain('greenroom-stale-build');
    expect(out).toContain('older build');
    // The original document survives, and the bar lands inside <body>.
    expect(out).toContain('<div id="root"></div>');
    expect(out.indexOf('greenroom-stale-build')).toBeLessThan(out.indexOf('</body>'));
    expect(out.indexOf('<div id="root"></div>')).toBeLessThan(out.indexOf('greenroom-stale-build'));
  });

  it('points at the newer build', () => {
    const out = dec(withStaleBuildNotice(page(), 'build-2'));
    expect(out).toContain('href="/builds/build-2/index.html"');
  });

  it('carries the reader to the same story rather than the root', () => {
    const out = dec(withStaleBuildNotice(page(), 'build-2', '/story/forms-input--default'));
    expect(out).toContain(
      'href="/builds/build-2/index.html?path=%2Fstory%2Fforms-input--default"',
    );
  });

  /*
   * `path` arrives from a query string, so it is reader-controlled and lands in an HTML
   * attribute. Both layers are checked: percent-encoding stops it escaping the attribute
   * value, and the entity escape stops a stray quote closing it.
   */
  it('does not let a crafted path break out of the href', () => {
    const out = dec(withStaleBuildNotice(page(), 'b', '"><script>alert(1)</script>'));
    expect(out).not.toContain('"><script>alert(1)</script>');
    expect(out).not.toContain('<script>alert(1)');
  });

  it('does not let a crafted build id break out either', () => {
    const out = dec(withStaleBuildNotice(page(), '"><img src=x onerror=alert(1)>'));
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('onerror=alert(1)');
  });

  it('still appends when the document has no </body>', () => {
    const out = dec(withStaleBuildNotice(enc('<html><body>no closing tag'), 'build-2'));
    expect(out).toContain('greenroom-stale-build');
  });

  it('is byte-identical input to output apart from the bar', () => {
    const original = dec(page());
    const out = dec(withStaleBuildNotice(page(), 'build-2'));
    const stripped = out.slice(0, out.indexOf('\n<div id="greenroom-stale-build"')) + '</body></html>';
    expect(stripped).toBe(original);
  });
});
