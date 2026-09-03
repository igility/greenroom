import { describe, expect, it } from 'vitest';
import { withBuildMeta, withStaleBuildNotice } from '../src/util.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const page = (body = '<div id="root"></div>') =>
  enc(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`);

describe('withStaleBuildNotice', () => {
  it('inserts the bar before </body> and leaves the document otherwise intact', () => {
    const out = dec(withStaleBuildNotice(page()));
    expect(out).toContain('greenroom-stale-build');
    expect(out).toContain('older build');
    // The original document survives, and the bar lands inside <body>.
    expect(out).toContain('<div id="root"></div>');
    expect(out.indexOf('greenroom-stale-build')).toBeLessThan(out.indexOf('</body>'));
    expect(out.indexOf('<div id="root"></div>')).toBeLessThan(out.indexOf('greenroom-stale-build'));
  });

  it('points at the stable address, which cannot itself go stale', () => {
    // It used to point at the NEWEST build's pinned URL — which handed the reviewer a
    // fresh address that would rot in turn, and the next bookmark recreated the trap
    // the banner exists to escape.
    const out = dec(withStaleBuildNotice(page()));
    expect(out).toContain('href="/latest/index.html"');
    expect(out).not.toContain('href="/builds/');
  });

  it('carries the reader to the same story rather than the root', () => {
    const out = dec(withStaleBuildNotice(page(), '/story/forms-input--default'));
    expect(out).toContain('href="/latest/index.html?path=%2Fstory%2Fforms-input--default"');
  });

  /*
   * `path` arrives from a query string, so it is reader-controlled and lands in an HTML
   * attribute. Both layers are checked: percent-encoding stops it escaping the attribute
   * value, and the entity escape stops a stray quote closing it.
   */
  it('does not let a crafted path break out of the href', () => {
    const out = dec(withStaleBuildNotice(page(), '"><script>alert(1)</script>'));
    expect(out).not.toContain('"><script>alert(1)</script>');
    expect(out).not.toContain('<script>alert(1)');
  });

  it('withBuildMeta does not let a crafted build id break out of the meta tag', () => {
    const out = dec(withBuildMeta(page(), '"><img src=x onerror=alert(1)>'));
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('onerror=alert(1)');
  });

  it('withBuildMeta stamps the build into <head>', () => {
    const out = dec(withBuildMeta(page(), 'build-7'));
    expect(out).toContain('<meta name="greenroom-build" content="build-7">');
    expect(out.indexOf('greenroom-build')).toBeLessThan(out.indexOf('</head>'));
  });

  it('still appends when the document has no </body>', () => {
    const out = dec(withStaleBuildNotice(enc('<html><body>no closing tag')));
    expect(out).toContain('greenroom-stale-build');
  });

  it('is byte-identical input to output apart from the bar', () => {
    const original = dec(page());
    const out = dec(withStaleBuildNotice(page()));
    const stripped = out.slice(0, out.indexOf('\n<div id="greenroom-stale-build"')) + '</body></html>';
    expect(stripped).toBe(original);
  });
});
