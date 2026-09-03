import { describe, expect, it } from 'vitest';
import { withBuildMeta } from '../src/util.js';

/**
 * The build stamp.
 *
 * The reviewer's address deliberately names no build, so the id travels in the served
 * document instead — provenance must not depend on the URL. (The stale-build banner
 * that used to live alongside this is retired: pinned build URLs now redirect to the
 * root outright, which heals a stale bookmark rather than advising about it.)
 */

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => Buffer.from(b).toString('utf8');
const page = (body = '<div id="root"></div>') =>
  enc(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`);

describe('withBuildMeta', () => {
  it('stamps the build into <head>', () => {
    const out = dec(withBuildMeta(page(), 'build-7'));
    expect(out).toContain('<meta name="greenroom-build" content="build-7">');
    expect(out.indexOf('greenroom-build')).toBeLessThan(out.indexOf('</head>'));
  });

  it('does not let a crafted build id break out of the meta tag', () => {
    const out = dec(withBuildMeta(page(), '"><img src=x onerror=alert(1)>'));
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('onerror=alert(1)');
  });

  it('prepends when the document has no <head>', () => {
    const out = dec(withBuildMeta(enc('<html><body>x'), 'b1'));
    expect(out).toContain('greenroom-build');
  });
});
