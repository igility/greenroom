// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { buildIdFromPath, Sidecar } from '../src/api.js';

/**
 * Which build a comment or an approval gets stamped with.
 *
 * The addon used to ask the server for `latest` at submit time. A reviewer link pins a
 * build id into the URL deliberately, so a tab sitting on an older build is the designed
 * behaviour — and every upload opened a window where a comment recorded the new build
 * while its pin and screenshot came from the old render. Nothing errored; the thread
 * looked normal. These pin the replacement.
 */
describe('reading the rendered build out of the path', () => {
  it('takes the id the sidecar is serving', () => {
    expect(buildIdFromPath('/builds/1fb46d1c-0144-4d48-8947-1ccf5ef2572a/index.html')).toBe(
      '1fb46d1c-0144-4d48-8947-1ccf5ef2572a',
    );
  });

  it('reads it from any depth, not just the index', () => {
    expect(buildIdFromPath('/builds/abc123/iframe.html?id=components-button--primary')).toBe(
      'abc123',
    );
    expect(buildIdFromPath('/builds/abc123/sb-addons/greenroom/manager.mjs')).toBe('abc123');
  });

  it('returns null for local Storybook, which is what the fallback is for', () => {
    // localhost:6006 has no build in its path because nothing has been uploaded. This is
    // the ONLY case allowed to fall through to latestBuild().
    expect(buildIdFromPath('/')).toBeNull();
    expect(buildIdFromPath('/iframe.html')).toBeNull();
  });

  it('does not match a path that merely mentions builds', () => {
    // Guards against a story or asset route being mistaken for a build root.
    expect(buildIdFromPath('/api/builds/latest')).toBeNull();
    expect(buildIdFromPath('/review/builds/abc/index.html')).toBeNull();
  });

  it('requires the trailing slash, so a bare /builds/<id> is not a render root', () => {
    expect(buildIdFromPath('/builds/abc123')).toBeNull();
  });
});

describe('which build a submission is stamped with', () => {
  /** Stands in for the sidecar so the test can see whether it was asked anything at all. */
  const sidecarThatCounts = () => {
    let calls = 0;
    const fetchSpy = async () => {
      calls += 1;
      return new Response(JSON.stringify({ build: { id: 'NEWEST-ON-SERVER' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { fetchSpy, calls: () => calls };
  };

  const withPath = (pathname: string) => {
    // jsdom will not navigate cross-path, so replace the accessor the code reads.
    Object.defineProperty(window, 'location', {
      value: { pathname },
      writable: true,
      configurable: true,
    });
  };

  it('uses the build in the URL and does NOT ask the server for latest', async () => {
    // The whole bug in one assertion. A tab open on an older build must stamp THAT build,
    // and must not consult `latest` — a lookup that would silently return whatever was
    // uploaded most recently while the pin and screenshot came from the old render.
    const { fetchSpy, calls } = sidecarThatCounts();
    vi.stubGlobal('fetch', fetchSpy);
    withPath('/builds/OLD-BUILD-ON-SCREEN/index.html');

    const client = new Sidecar({ url: 'https://design.example.com', token: 't' });
    expect(await client.currentBuildId()).toBe('OLD-BUILD-ON-SCREEN');
    expect(calls()).toBe(0);
  });

  it('falls back to latest only when the path carries no build — local dev', async () => {
    const { fetchSpy, calls } = sidecarThatCounts();
    vi.stubGlobal('fetch', fetchSpy);
    withPath('/');

    const client = new Sidecar({ url: 'http://localhost:4788', token: 't' });
    expect(await client.currentBuildId()).toBe('NEWEST-ON-SERVER');
    expect(calls()).toBe(1);
  });
});
