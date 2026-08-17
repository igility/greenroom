import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { HttpError } from '../src/util.js';

const store = () => new Store(openMemoryDb(), '/tmp/greenroom-test-nonexistent');

describe('deleteReviewer', () => {
  it('removes a reviewer who never used their link', () => {
    const s = store();
    const r = s.createReviewer({ name: 'Smoke test', email: 'smoke@test.invalid' });
    s.createMagicLink(r.id);
    expect(s.listReviewers().map((x) => x.id)).toContain(r.id);

    s.deleteReviewer(r.id);
    expect(s.listReviewers().map((x) => x.id)).not.toContain(r.id);
  });

  it('kills the link, so a token already handed out stops working', () => {
    const s = store();
    const r = s.createReviewer({ name: 'Smoke test', email: 'smoke@test.invalid' });
    const token = s.createMagicLink(r.id);
    // Sanity: it works before removal, or the assertion after proves nothing.
    expect(s.redeemMagicLink(token).reviewer.id).toBe(r.id);

    s.deleteReviewer(r.id);
    expect(() => s.redeemMagicLink(token)).toThrow();
  });

  it('is a 404 for a reviewer that does not exist', () => {
    const s = store();
    expect(() => s.deleteReviewer('nope')).toThrow(HttpError);
    try {
      s.deleteReviewer('nope');
    } catch (e) {
      expect((e as HttpError).status).toBe(404);
    }
  });

  /*
   * The refusal is the reason this method is safe to expose at all. Comments carry the
   * author's name denormalised, so they outlive the reviewer row — removing a participant
   * would leave a trail signed by someone absent from the reviewer list.
   */
  it('refuses to remove a reviewer who has commented', () => {
    const s = store();
    const r = s.createReviewer({ name: 'Real reviewer', email: 'real@test.invalid' });
    const build = s.ingestBuildZip(fixtureZip(), { label: 'b1' }, { kind: 'admin', id: 'admin', name: 'admin' });
    s.createThread(
      {
        storyId: 'components-button--primary',
        buildId: build.build.id,
        body: 'This needs to change.',
      },
      { kind: 'reviewer', id: r.id, name: r.name },
    );

    expect(() => s.deleteReviewer(r.id)).toThrow(/has taken part/);
    expect(s.listReviewers().map((x) => x.id)).toContain(r.id);
  });
});

/* A minimal storybook-static zip, enough for one story to exist to comment on. */
function fixtureZip(): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { zipSync } = require('fflate') as typeof import('fflate');
  const enc = (s: string) => new TextEncoder().encode(s);
  return zipSync({
    'index.json': enc(
      JSON.stringify({
        v: 5,
        entries: {
          'components-button--primary': {
            id: 'components-button--primary',
            title: 'Components/Button',
            name: 'Primary',
            importPath: './src/Button.stories.tsx',
            type: 'story',
          },
        },
      }),
    ),
    'index.html': enc('<!doctype html><html><body></body></html>'),
  });
}
