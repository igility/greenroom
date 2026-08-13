import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { HttpError } from '../src/util.js';
import { SHEET_TAG, ROOT_REGION, type Principal } from '@igility/greenroom-shared';

/**
 * Contact sheets survey other stories. Everything here defends one line: a sheet is a
 * navigation and batch surface, never a review unit. Each test corresponds to a way the
 * first draft of this design would have signed off work nobody looked at, or sent an
 * agent to edit the review instrument instead of the product.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const admin: Principal = { kind: 'admin', id: 'a', name: 'Admin' };

const SHEET = 'library-forms--sheet';
const INPUT = 'components-input--default';
const SELECT = 'components-select--default';

/** A build containing one contact sheet and the two components it surveys. */
const zip = (marker: string) =>
  zipSync({
    'index.json': enc(
      JSON.stringify({
        v: 5,
        entries: {
          [SHEET]: {
            type: 'story',
            title: 'Component library/Forms',
            name: 'Sheet',
            importPath: './stories/library/Forms.stories.tsx',
            tags: ['dev', 'test', SHEET_TAG],
          },
          [INPUT]: {
            type: 'story',
            title: 'Components/Forms/Input',
            name: 'Default',
            importPath: './src/components/forms/Input.stories.tsx',
            tags: ['dev', 'test'],
          },
          [SELECT]: {
            type: 'story',
            title: 'Components/Forms/Select',
            name: 'Default',
            importPath: './src/components/forms/Select.stories.tsx',
            tags: ['dev', 'test'],
          },
        },
      }),
    ),
    'iframe.html': enc(`<html>${marker}</html>`),
  });

let dataDir: string;
let store: Store;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-sheets-'));
  store = new Store(openMemoryDb(), dataDir);
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('sheet classification', () => {
  it('reads the sheet tag from index.json into a persisted kind', () => {
    store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    expect(store.getStory(SHEET).kind).toBe('sheet');
    expect(store.getStory(INPUT).kind).toBe('story');
  });

  it('excludes sheets from the agent work queue while keeping them for the reviewer', () => {
    store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    // The agent's queue must never contain a sheet: its importPath points at the
    // contact-sheet CSF file, which contains no product code to fix.
    const forAgent = store.listStories({ kind: 'story' }).map((s) => s.storyId);
    expect(forAgent).not.toContain(SHEET);
    expect(forAgent).toEqual([INPUT, SELECT]);
    // The reviewer navigates by sheet, so the unfiltered list still has it.
    expect(store.listStories().map((s) => s.storyId)).toContain(SHEET);
  });

  it('reclassifies when the sheet tag is added or removed in a later build', () => {
    store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    const untagged = zipSync({
      'index.json': enc(
        JSON.stringify({
          v: 5,
          entries: {
            [SHEET]: {
              type: 'story',
              title: 'Component library/Forms',
              name: 'Sheet',
              importPath: './stories/library/Forms.stories.tsx',
              tags: ['dev', 'test'],
            },
          },
        }),
      ),
      'iframe.html': enc('<html>b</html>'),
    });
    store.ingestBuildZip(untagged, { label: 'v2' }, admin);
    expect(store.getStory(SHEET).kind).toBe('story');
  });
});

describe('Storybook 10 test entries are not review units', () => {
  /** SB10 emits attached tests as type:'story' with subtype:'test', repeating the
   *  parent's exportName. SB9 emits neither field while declaring the same index
   *  version, so an absent subtype has to keep reading as a story. */
  const withTests = zipSync({
    'index.json': enc(
      JSON.stringify({
        v: 5,
        entries: {
          [INPUT]: {
            type: 'story',
            subtype: 'story',
            title: 'Components/Forms/Input',
            name: 'Default',
            importPath: './src/components/forms/Input.stories.tsx',
            exportName: 'Default',
          },
          'components-input--default-handles-a-click': {
            type: 'story',
            subtype: 'test',
            title: 'Components/Forms/Input',
            name: 'handles a click',
            importPath: './src/components/forms/Input.stories.tsx',
            exportName: 'Default',
          },
          'legacy-sb9--story': {
            type: 'story',
            title: 'Legacy/SB9',
            name: 'Story',
            importPath: './src/Legacy.stories.tsx',
          },
        },
      }),
    ),
    'iframe.html': enc('<html>t</html>'),
  });

  it('ingests the story and the subtype-less entry, but not the test', () => {
    store.ingestBuildZip(withTests, { label: 'v1' }, admin);
    expect(store.listStories().map((s) => s.storyId).sort()).toEqual([
      INPUT,
      'legacy-sb9--story',
    ]);
  });
});

describe('a sheet is not a review unit', () => {
  it('refuses to approve a sheet', () => {
    store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    let thrown: HttpError | null = null;
    try {
      store.setStoryState(SHEET, 'approved', admin);
    } catch (e) {
      thrown = e as HttpError;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown!.status).toBe(400);
    expect(thrown!.reason).toBe('NOT_A_REVIEW_UNIT');
  });

  it('never puts a sheet into the re-confirm queue on a new build', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    store.setStoryState(INPUT, 'approved', admin, { buildId: a.build.id });

    store.ingestBuildZip(zip('b'), { label: 'v2' }, admin);

    // The approved component correctly needs re-confirmation. The sheet, which was
    // never approved and cannot be, must not appear as work for the reviewer.
    expect(store.getStory(INPUT).state).toBe('needs_reconfirm');
    expect(store.getStory(SHEET).state).toBe('in_review');
  });
});

describe('comment routing from a tile', () => {
  const comment = (buildId: string, regionStoryId: string | null, body = 'Too cramped.') =>
    store.createThread({ storyId: SHEET, regionStoryId, buildId, body }, admin);

  it('attributes a tile comment to the component and records where it was said', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    const item = comment(a.build.id, INPUT);

    // The fix happens on the component, so that is where the thread lives — and
    // approving the component is what clears it.
    expect(item.thread.storyId).toBe(INPUT);
    expect(item.thread.seenOnStoryId).toBe(SHEET);
    expect(item.story.importPath).toBe('./src/components/forms/Input.stories.tsx');
  });

  it('shows a routed comment on the sheet the reviewer is standing on', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    comment(a.build.id, INPUT);

    // Without this the reviewer posts a comment, the rail refetches for the sheet,
    // and their own words disappear with no error.
    const onSheet = store.listFeedback({ storyId: SHEET });
    expect(onSheet.map((f) => f.thread.storyId)).toEqual([INPUT]);
    // And it is still on the component, for the agent that has to fix it.
    expect(store.listFeedback({ storyId: INPUT }).map((f) => f.thread.storyId)).toEqual([INPUT]);
  });

  it('shows a member thread on the sheet even when it was raised somewhere else', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    store.putRenderReport(SHEET, a.build.id, {
      hash: 'root',
      regions: [{ regionKey: INPUT, hash: 'i' }],
    });
    // Raised directly on the component, not via this sheet.
    store.createThread({ storyId: INPUT, buildId: a.build.id, body: 'Wrong blue.' }, admin);

    // A second reviewer arriving via the sheet must not see a clean tile and approve
    // over a flag someone else raised.
    expect(store.listFeedback({ storyId: SHEET }).map((f) => f.thread.storyId)).toEqual([INPUT]);
  });

  it('keeps a comment on the sheet itself when no tile was clicked', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    const item = comment(a.build.id, null, 'These are all too cramped.');

    // The most common thing anyone says about a grid is about the grid.
    expect(item.thread.storyId).toBe(SHEET);
    expect(item.thread.seenOnStoryId).toBe(SHEET);
    expect(store.listFeedback({ storyId: SHEET })).toHaveLength(1);
  });

  it('falls back to the surface rather than losing a comment on a stale tile id', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    const item = comment(a.build.id, 'components-phonefield--gone');

    // A reviewer who has typed something must never lose it because host markup
    // named a story that no longer exists.
    expect(item.thread.storyId).toBe(SHEET);
    expect(store.listFeedback({ storyId: SHEET })).toHaveLength(1);
  });
});

describe('render reports: membership and per-region fingerprints', () => {
  it('records membership and region hashes from one render report', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    store.putRenderReport(SHEET, a.build.id, {
      hash: 'root-hash',
      regions: [
        { regionKey: INPUT, hash: 'input-1' },
        { regionKey: SELECT, hash: 'select-1' },
      ],
    });

    expect(store.sheetMembers(SHEET, a.build.id).map((m) => m.memberStoryId)).toEqual([
      INPUT,
      SELECT,
    ]);
    // The root hash still lands where the existing re-confirm sort reads it.
    expect(store.fingerprintCount(a.build.id)).toBe(1);
  });

  it('replaces membership rather than merging, so a removed tile disappears', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    store.putRenderReport(SHEET, a.build.id, {
      hash: 'r',
      regions: [
        { regionKey: INPUT, hash: 'i' },
        { regionKey: SELECT, hash: 's' },
      ],
    });
    store.putRenderReport(SHEET, a.build.id, { hash: 'r', regions: [{ regionKey: INPUT, hash: 'i' }] });

    expect(store.sheetMembers(SHEET, a.build.id).map((m) => m.memberStoryId)).toEqual([INPUT]);
  });

  it('records no membership for a non-sheet story that declares regions', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    store.putRenderReport(INPUT, a.build.id, {
      hash: 'root',
      regions: [{ regionKey: SELECT, hash: 'x' }],
    });
    // Regions are still fingerprinted — a page layout may label its own areas — but
    // only a declared sheet contributes membership.
    expect(store.sheetMembers(INPUT, a.build.id)).toEqual([]);
  });

  it('reports per-tile verdicts so round two shows only what moved', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    store.putRenderReport(SHEET, a.build.id, {
      hash: 'root-a',
      regions: [
        { regionKey: INPUT, hash: 'input-1' },
        { regionKey: SELECT, hash: 'select-1' },
      ],
    });
    store.setStoryState(INPUT, 'approved', admin, { buildId: a.build.id });
    store.setStoryState(SELECT, 'approved', admin, { buildId: a.build.id });

    const b = store.ingestBuildZip(zip('b'), { label: 'v2' }, admin);
    store.putRenderReport(SHEET, b.build.id, {
      hash: 'root-b',
      regions: [
        { regionKey: INPUT, hash: 'input-1' }, // untouched
        { regionKey: SELECT, hash: 'select-2' }, // changed
      ],
    });

    expect(store.sheetRegionVerdicts(SHEET, b.build.id)).toEqual([
      { storyId: INPUT, verdict: 'likely_unchanged' },
      { storyId: SELECT, verdict: 'changed' },
    ]);
  });

  it('reports unknown rather than unchanged for a member with no approval anchor', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    store.putRenderReport(SHEET, a.build.id, {
      hash: 'root',
      regions: [{ regionKey: INPUT, hash: 'input-1' }],
    });
    // Nothing was approved, so there is no baseline. Claiming "likely unchanged" here
    // would imply a comparison that never happened.
    expect(store.sheetRegionVerdicts(SHEET, a.build.id)).toEqual([
      { storyId: INPUT, verdict: 'unknown' },
    ]);
  });

  it('drops and reports a region naming a story absent from the build', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    const report = store.putRenderReport(SHEET, a.build.id, {
      hash: 'root',
      regions: [
        { regionKey: INPUT, hash: 'i' },
        // What a stale hardcoded tile id looks like after the component is retitled:
        // the string literal in the sheet still parses, and the build still succeeds.
        { regionKey: 'components-phonefield--stale', hash: 'x' },
      ],
    });

    expect(report).toEqual({ recorded: 1, unresolved: ['components-phonefield--stale'] });
    expect(store.sheetMembers(SHEET, a.build.id).map((m) => m.memberStoryId)).toEqual([INPUT]);
    // No verdict is emitted for it — a confident verdict computed against a story that
    // is not in the build is worse than no verdict at all.
    expect(store.sheetRegionVerdicts(SHEET, a.build.id).map((v) => v.storyId)).toEqual([INPUT]);
  });

  it('ignores a root region supplied in the regions list', () => {
    const a = store.ingestBuildZip(zip('a'), { label: 'v1' }, admin);
    store.putRenderReport(SHEET, a.build.id, {
      hash: 'root',
      regions: [
        { regionKey: ROOT_REGION, hash: 'bogus' },
        { regionKey: INPUT, hash: 'i' },
      ],
    });
    expect(store.sheetMembers(SHEET, a.build.id).map((m) => m.memberStoryId)).toEqual([INPUT]);
    expect(store.fingerprintCount(a.build.id)).toBe(1);
  });
});
