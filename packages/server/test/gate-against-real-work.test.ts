import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { HttpError } from '../src/util.js';
import type { Principal } from '@igility/greenroom-shared';

/**
 * What the gate does to the work a design review actually does, measured against a real
 * built story set rather than a fixture.
 *
 * The gate reads the story SET. Almost everything a design review does — rewording a
 * decision, moving a card down the page, changing its status, fixing a component — happens
 * INSIDE a story and is invisible to it. That is correct, and it is also the limit worth
 * knowing: dozens of decision cards can live in a handful of stories, so the gate cannot see one of them
 * disappear. The anchor is what protects a comment there. Two different mechanisms,
 * neither a substitute for the other.
 *
 * Skipped unless GREENROOM_REAL_BUILD names a built storybook-static directory.
 */
const admin: Principal = { kind: 'admin', id: 'a', name: 'Admin' };
const enc = (s: string) => new TextEncoder().encode(s);
/**
 * Point `GREENROOM_REAL_BUILD` at a built `storybook-static` directory to run these
 * against a real one. Unset, they skip — the questions here are about how the gate
 * behaves on a large true-to-life story set, and a fixture cannot answer them honestly.
 */
const REAL_BUILD = process.env.GREENROOM_REAL_BUILD;
const INDEX = REAL_BUILD ? path.join(REAL_BUILD, 'index.json') : '';
const HAVE = !!INDEX && fs.existsSync(INDEX);
const REAL = HAVE ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : { entries: {} };

const zipFrom = (index: unknown, body: string) =>
  zipSync({ 'index.json': enc(JSON.stringify(index)), 'iframe.html': enc(body) });

describe.skipIf(!HAVE)('a real, large story set under the changes we actually make', () => {
  const fresh = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    const store = new Store(openMemoryDb(), dir);
    store.ingestBuildZip(zipFrom(REAL, 'v1'), { label: 'live' }, admin);
    return store;
  };

  it('rewording a decision card, reordering cards, re-statusing: no gate', () => {
    // Cards live INSIDE a story. Editing, moving or restatusing them changes the
    // rendered bytes and not the story set, which is what the gate reads.
    const store = fresh();
    const r = store.ingestBuildZip(zipFrom(REAL, 'v2-cards-rewritten'), { label: 'edits' }, admin);
    expect(r.created).toBe(true);
    expect(r.delta!.added).toEqual([]);
    expect(r.delta!.removed).toEqual([]);
    expect(r.delta!.concerns).toEqual([]);
  });

  it('adding a variant to an existing component: no gate', () => {
    const store = fresh();
    const withVariant = structuredClone(REAL);
    const proto = (Object.values(REAL.entries) as Record<string, unknown>[]).find(
      (e) => e.type === 'story',
    )!;
    // A genuinely new id — 'alert--warning' is already in the real index, which is what
    // made the first version of this test assert the wrong thing.
    withVariant.entries['components-feedback-alert--critical'] = {
      ...proto,
      id: 'components-feedback-alert--critical',
      name: 'Critical',
      title: 'Components/Feedback/Alert',
    };
    const r = store.ingestBuildZip(zipFrom(withVariant, 'v2'), { label: 'variant' }, admin);
    expect(r.created).toBe(true);
    expect(r.delta!.added).toHaveLength(1);
    expect(r.delta!.concerns).toEqual([]);
  });

  it('RENAMING a story does gate — it reads as a removal', () => {
    // The one everyday edit that trips it, and it should: a renamed story is a new id,
    // so every comment pinned to the old one stops resolving.
    const store = fresh();
    const renamed = structuredClone(REAL);
    const [oldId, entry] = Object.entries(REAL.entries).find(([k]) =>
      k.includes('alert--info'),
    ) as [string, Record<string, unknown>];
    delete renamed.entries[oldId];
    renamed.entries['components-feedback-alert--information'] = { ...entry, name: 'Information' };
    expect(() => store.ingestBuildZip(zipFrom(renamed, 'v2'), { label: 'rename' }, admin)).toThrow(
      HttpError,
    );
  });

  it('deleting a decision card does NOT gate — the story survives', () => {
    // 🔴 The blind spot, stated as a test rather than a caveat. 35 cards live in three
    // stories, so removing one is invisible here. What protects a comment on it is the
    // anchor, not this gate.
    const store = fresh();
    const r = store.ingestBuildZip(zipFrom(REAL, 'v2-one-card-deleted'), { label: 'del' }, admin);
    expect(r.created).toBe(true);
    expect(r.delta!.concerns).toEqual([]);
  });
});
