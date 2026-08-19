import fs from 'node:fs';
import path from 'node:path';
import {
  canTransition,
  type AgentApprovalPolicy,
  type ApprovalMode,
  type Build,
  type Delegation,
  type FingerprintVerdict,
  type Message,
  type MessageKind,
  type Pin,
  type Principal,
  type PrincipalKind,
  type Reviewer,
  type ReviewerRole,
  type RegionFingerprint,
  type SheetMember,
  type StatusEvent,
  type Story,
  type StoryKind,
  type AnchorManifest,
  type StoryState,
  type Thread,
  type ThreadState,
  ROOT_REGION,
} from '@igility/greenroom-shared';
import type { DB } from './db.js';
import { id, nowIso, secret, sha256Hex, HttpError } from './util.js';
import {
  manifestHash,
  parseAnchorManifest,
  parseStoryIndex,
  readZip,
  writeEntries,
  type ZipEntries,
} from './zip.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface BuildUploadResult {
  build: Build;
  created: boolean;
  newStories: number;
  /** What this upload changes about the reviewable surface. Null on a deduped re-upload,
   *  and on the very first build, where there is nothing to compare against. */
  delta: StoryDelta | null;
}

/** A story the incoming build drops, and what review history goes quiet with it. */
export interface RemovedStory {
  storyId: string;
  title: string;
  componentTitle: string;
  group: string;
  pathGroup: string;
  /** Where the story had got to. Losing an `approved` one erases a sign-off. */
  state: StoryState;
  /** Threads still awaiting an answer. These are the reason removals are gated: the
   *  comment survives in the database and becomes unreachable on the surface. */
  openThreads: number;
  totalThreads: number;
}

/**
 * An anchored item that a build drops while the story around it survives.
 *
 * The story-level check cannot see this. 35 decision cards live in three stories on the
 * project this was built for, so deleting one changes no story id, produces no delta, and
 * silently strands every comment pinned to it. This is the element-level equivalent.
 */
export interface DroppedAnchor {
  anchor: string;
  /** The surface the anchor lives on — where the pin was taken. */
  storyId: string;
  openThreads: number;
  totalThreads: number;
  /** First line of the oldest comment, so the report says what is about to go quiet
   *  rather than only how much of it there is. */
  sample: string;
}

/**
 * A block of stories moving together, as the reviewer's sidebar groups them.
 *
 * `pathGroups` is carried alongside because the two hierarchies can disagree, and the
 * disagreement is worth seeing: on the project this was built for, 32 stories titled
 * `Pages/Marketing` live in `stories/pages/system-utility`, so a build scoped by
 * DIRECTORY ships marketing pages to anyone told the batch contains utility screens.
 * Reporting only one of the two hides that permanently.
 */
export interface StoryGroup {
  group: string;
  count: number;
  pathGroups: string[];
}

/**
 * What an upload does to the reviewable surface, measured against the build that is
 * currently live — the one a reviewer's link lands on.
 *
 * Greenroom knows both sets, so it can answer "what is about to change for the client"
 * without being told anything about the project's own staging conventions. That is the
 * whole point: the caller cannot be relied upon to know, because the caller is usually
 * an agent running a build command it did not write.
 */
export interface StoryDelta {
  liveBuild: { id: string; label: string } | null;
  added: { storyId: string; title: string; componentTitle: string; group: string; pathGroup: string }[];
  removed: RemovedStory[];
  addedGroups: StoryGroup[];
  removedGroups: StoryGroup[];
  liveCount: number;
  incomingCount: number;
  /** Anchored items that vanish while their story survives. Empty when the build ships
   *  no anchor manifest, which only means the check did not run. */
  droppedAnchors: DroppedAnchor[];
  /** Groups the caller claimed that are not in this build at all. Not fatal — claiming a
   *  named scope whose other groups are already live is ordinary — but printed, because
   *  it also describes someone who thinks they built something they did not. */
  unmatchedClaims: string[];
  /** Where the title hierarchy and the directory hierarchy disagree about the same
   *  stories. Never blocks; always shown. */
  groupMismatches: string[];
  /** Why this delta is being gated, empty when it is routine. Each entry is shown to
   *  whoever ran the upload, so it reads as a sentence rather than a code. */
  concerns: string[];
}

/** What an upload is allowed to change, as claimed by whoever ran it. */
export interface UploadClaims {
  /** Groups or scope names the caller asserts this build adds. */
  allowAdded?: string[];
  /** Groups or scope names the caller asserts this build removes. */
  allowRemoved?: string[];
  /** The blunt override: permits anything. Kept for first-run and automation, and named
   *  so it reads as the weaker instrument it is. */
  allowStoryChanges?: boolean;
}

export interface Scope {
  name: string;
  groups: string[];
  createdAt: string;
  createdBy: string;
}

/**
 * The reviewer-facing group of a story: the first two segments of its Storybook title,
 * which is the level the sidebar collapses to and the level people name in conversation
 * ("clinical", "auth"). One segment is used when that is all there is.
 */
export function titleGroup(title: string): string {
  const parts = title.split('/').map((p) => p.trim()).filter(Boolean);
  return parts.slice(0, 2).join('/') || title;
}

/**
 * The anchor value a pin was attached to, when it has one.
 *
 * Selectors are stored as `finder` produced them, so an anchored pin reads
 * `[data-greenroom-anchor="decision-radius"]` — possibly with more path around it. A pin
 * with no anchor returns null and is simply not checkable this way; it is positional, and
 * fragile to changes this cannot see.
 */
export function anchorInSelector(selector: string | null): string | null {
  if (!selector) return null;
  const m = /\[data-greenroom-anchor="([^"]+)"\]/.exec(selector);
  return m ? m[1]! : null;
}

/** The directory a story's source sits in — the hierarchy a build-scope variable selects
 *  on, which is not always the one the reviewer sees. */
export function pathGroup(importPath: string): string {
  return importPath.replace(/^\.\//, '').replace(/\/[^/]*$/, '');
}

/**
 * How much growth passes without a word.
 *
 * A design system under active work adds stories on most uploads, so gating every
 * addition would train whoever deploys to pass the override reflexively — and an
 * override that is always passed is not a gate. The threshold exists to keep the
 * interruption rare enough that it still means something when it fires.
 *
 * Proportional rather than absolute so it travels to projects of other sizes, with a
 * floor so a small surface is not gated by its third story.
 */
const GROWTH_FRACTION = 0.1;
const GROWTH_FLOOR = 10;

/** How much of a link token a listing shows. Enough to identify a row for revocation,
 *  far too little to reach the review with. */
const TOKEN_PREFIX_LEN = 10;

export interface MagicLinkSummary {
  /** Never the whole token — see `listMagicLinks`. */
  tokenPrefix: string;
  reviewer: { id: string; name: string; email: string };
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Unexpired sessions this link minted. What revoking it would end. */
  liveSessions: number;
  /** Neither revoked nor past its expiry. */
  active: boolean;
}

export interface TokenSummary {
  id: string;
  kind: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface FeedbackItem {
  thread: Thread;
  story: Pick<Story, 'storyId' | 'title' | 'componentTitle' | 'importPath' | 'state'>;
  messages: Message[];
}

/** Greenroom itself, for state changes made on evidence rather than by anybody. Never
 *  attributed to a person or an agent: an export must not imply someone acted. */
const SYSTEM_PRINCIPAL: Principal = { kind: 'admin', id: 'greenroom', name: 'Greenroom' };

export class Store {
  constructor(
    private db: DB,
    private dataDir: string,
  ) {}

  // ── builds ────────────────────────────────────────────────────────────────

  /* ---- named audience scopes ------------------------------------------------ */

  setScope(name: string, groups: string[], by: Principal): Scope {
    const clean = groups.map((g) => g.trim()).filter(Boolean);
    if (!clean.length) throw new HttpError(400, 'A scope needs at least one group.');
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO scopes (name, groups_json, created_at, created_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET groups_json = excluded.groups_json,
                                         created_at = excluded.created_at,
                                         created_by = excluded.created_by`,
      )
      .run(name.trim(), JSON.stringify(clean), at, by.name);
    return { name: name.trim(), groups: clean, createdAt: at, createdBy: by.name };
  }

  listScopes(): Scope[] {
    return (
      this.db.prepare('SELECT * FROM scopes ORDER BY name').all() as {
        name: string;
        groups_json: string;
        created_at: string;
        created_by: string;
      }[]
    ).map((r) => ({
      name: r.name,
      groups: JSON.parse(r.groups_json) as string[],
      createdAt: r.created_at,
      createdBy: r.created_by,
    }));
  }

  deleteScope(name: string): boolean {
    return this.db.prepare('DELETE FROM scopes WHERE name = ?').run(name).changes > 0;
  }

  /**
   * Turns what the caller claimed into the set of groups it permits.
   *
   * A claim is either a group as the reviewer sees it (`Pages/Clinical`) or the name of a
   * stored scope (`batch2`). The scope form is the one worth having: nobody thinks in
   * group names, so a gate that only accepts them gets satisfied by pasting whatever the
   * refusal printed. `batch2` is a sentence the operator has to mean.
   */
  private resolveClaims(claims: string[]): Set<string> {
    const scopes = new Map(this.listScopes().map((s) => [s.name.toLowerCase(), s.groups]));
    const out = new Set<string>();
    for (const raw of claims) {
      const claim = raw.trim();
      if (!claim) continue;
      const scope = scopes.get(claim.toLowerCase());
      if (scope) for (const g of scope) out.add(g);
      else out.add(claim);
    }
    return out;
  }

  /** Collapses stories into the blocks a reviewer would name, carrying the directory
   *  hierarchy alongside so the two can be compared. */
  private groupsOf(items: { group: string; pathGroup: string }[]): StoryGroup[] {
    const by = new Map<string, { count: number; paths: Set<string> }>();
    for (const i of items) {
      const e = by.get(i.group) ?? { count: 0, paths: new Set<string>() };
      e.count += 1;
      e.paths.add(i.pathGroup);
      by.set(i.group, e);
    }
    return [...by.entries()]
      .map(([group, e]) => ({ group, count: e.count, pathGroups: [...e.paths].sort() }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * What an incoming build changes about the reviewable surface, against the live one.
   *
   * "Live" is the build a reviewer's link lands on — `latestBuild()` — and the stories in
   * it are those whose `last_seen_build_id` points at it. Comparing against the whole
   * `stories` table instead would be wrong: it accumulates everything ever uploaded, so a
   * story dropped three builds ago would keep counting as present.
   */
  storyDelta(
    incoming: { storyId: string; title: string; componentTitle?: string; importPath: string }[],
    claims: UploadClaims = {},
    manifest: AnchorManifest | null = null,
  ): StoryDelta {
    const live = this.latestBuild();
    const incomingIds = new Set(incoming.map((s) => s.storyId));

    const empty = {
      addedGroups: [],
      removedGroups: [],
      droppedAnchors: [],
      unmatchedClaims: [],
      groupMismatches: [],
    };

    if (!live) {
      // First build. Everything is new by definition, and there is no surface to disturb.
      return {
        liveBuild: null,
        added: [],
        removed: [],
        ...empty,
        liveCount: 0,
        incomingCount: incoming.length,
        concerns: [],
      };
    }

    const liveRows = this.db
      .prepare(
        `SELECT story_id, title, component_title, import_path, state FROM stories WHERE last_seen_build_id = ?`,
      )
      .all(live.id) as {
      story_id: string;
      title: string;
      component_title: string;
      import_path: string;
      state: StoryState;
    }[];

    const liveIds = new Set(liveRows.map((r) => r.story_id));
    const added = incoming
      .filter((s) => !liveIds.has(s.storyId))
      .map((s) => ({
        storyId: s.storyId,
        title: s.title,
        componentTitle: s.componentTitle ?? '',
        group: titleGroup(s.componentTitle || s.title),
        pathGroup: pathGroup(s.importPath),
      }));

    const threadCounts = this.db.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open
         FROM threads WHERE story_id = ?`,
    );
    const removed: RemovedStory[] = liveRows
      .filter((r) => !incomingIds.has(r.story_id))
      .map((r) => {
        const c = threadCounts.get(r.story_id) as { total: number; open: number | null };
        return {
          storyId: r.story_id,
          title: r.title,
          componentTitle: r.component_title,
          group: titleGroup(r.component_title || r.title),
          pathGroup: pathGroup(r.import_path),
          state: r.state,
          openThreads: c?.open ?? 0,
          totalThreads: c?.total ?? 0,
        };
      });

    const addedGroups = this.groupsOf(added);
    const removedGroups = this.groupsOf(removed);

    /*
     * Where the two hierarchies disagree about the same stories. Never blocks — it is a
     * property of the host project, not of this upload — but it is exactly the kind of
     * thing that is invisible until it has already shipped to somebody.
     */
    const groupMismatches: string[] = [];
    const byPath = new Map<string, Set<string>>();
    for (const a of [...added, ...removed]) {
      const set = byPath.get(a.pathGroup) ?? new Set<string>();
      set.add(a.group);
      byPath.set(a.pathGroup, set);
    }
    for (const [path, titles] of byPath) {
      if (titles.size > 1) {
        groupMismatches.push(`${path} carries more than one section: ${[...titles].sort().join(', ')}`);
      }
    }
    for (const g of [...addedGroups, ...removedGroups]) {
      if (g.pathGroups.length > 1) {
        groupMismatches.push(`${g.group} is spread across ${g.pathGroups.join(', ')}`);
      }
    }

    /*
     * Anchored items that go while their story stays.
     *
     * Only checked for stories the incoming build still HAS: a story that disappeared is
     * already reported at story level, and re-reporting each of its anchors would bury
     * that under noise. Only threads that are still open matter — a resolved one going
     * quiet is the normal end of its life.
     */
    const droppedAnchors: DroppedAnchor[] = [];
    if (manifest) {
      const anchored = this.db
        .prepare(
          `SELECT t.id, t.selector, t.state, COALESCE(t.seen_on_story_id, t.story_id) AS surface,
                  t.created_at,
                  (SELECT body FROM messages WHERE thread_id = t.id ORDER BY created_at LIMIT 1) AS first_message
             FROM threads t
            WHERE t.selector IS NOT NULL`,
        )
        .all() as {
        id: string;
        selector: string;
        state: ThreadState;
        surface: string;
        created_at: string;
        first_message: string | null;
      }[];

      const byAnchor = new Map<string, typeof anchored>();
      for (const t of anchored) {
        const anchor = anchorInSelector(t.selector);
        // Only surfaces this build still ships. A vanished story is story-level news.
        if (!anchor || !incomingIds.has(t.surface)) continue;
        const key = `${t.surface}\u0000${anchor}`;
        byAnchor.set(key, [...(byAnchor.get(key) ?? []), t]);
      }

      for (const [key, threads] of byAnchor) {
        const [surface, anchor] = key.split('\u0000') as [string, string];
        const present = manifest.anchors[surface];
        // A story absent from the manifest declares nothing, which is not the same as
        // declaring emptiness — treating it as empty would report every anchor on every
        // story a host only partly instruments.
        if (!present || present.includes(anchor)) continue;
        const open = threads.filter((t) => t.state === 'open');
        if (!open.length) continue;
        const oldest = [...open].sort((a, b) => a.created_at.localeCompare(b.created_at))[0]!;
        droppedAnchors.push({
          anchor,
          storyId: surface,
          openThreads: open.length,
          totalThreads: threads.length,
          sample: (oldest.first_message ?? '').split('\n')[0]!.slice(0, 100),
        });
      }
    }

    const allowedAdded = this.resolveClaims(claims.allowAdded ?? []);
    const allowedRemoved = this.resolveClaims(claims.allowRemoved ?? []);
    const present = new Set([
      ...[...addedGroups, ...removedGroups].map((g) => g.group),
      ...droppedAnchors.map((a) => a.anchor),
    ]);
    const unmatchedClaims = [...new Set([...allowedAdded, ...allowedRemoved])].filter(
      (c) => !present.has(c),
    );

    const concerns: string[] = [];

    // ---- removals: always material, whatever their size ----
    const unclaimedRemoved = removedGroups.filter((g) => !allowedRemoved.has(g.group));
    if (unclaimedRemoved.length) {
      const gone = unclaimedRemoved.flatMap((g) =>
        removed.filter((r) => r.group === g.group),
      );
      const withComments = gone.filter((r) => r.totalThreads > 0);
      const approvedGone = gone.filter((r) => r.state === 'approved');
      if (withComments.length) {
        const openTotal = withComments.reduce((n, r) => n + r.openThreads, 0);
        concerns.push(
          `${withComments.length} disappearing ${withComments.length === 1 ? 'story carries' : 'stories carry'} ` +
            `${openTotal} open comment${openTotal === 1 ? '' : 's'} — the comments survive in the database and ` +
            `become unreachable on the surface.`,
        );
      }
      if (approvedGone.length) {
        concerns.push(
          `${approvedGone.length} approved ${approvedGone.length === 1 ? 'story is' : 'stories are'} dropped, ` +
            `which removes a sign-off from the surface it was granted on.`,
        );
      }
      if (!withComments.length && !approvedGone.length) {
        concerns.push(
          `${gone.length} ${gone.length === 1 ? 'story disappears' : 'stories disappear'} from the ` +
            `reviewable surface, in ${unclaimedRemoved.map((g) => g.group).join(', ')}.`,
        );
      }
    }

    // ---- anchored items dropped out from under a live comment ----
    const unclaimedAnchors = droppedAnchors.filter((a) => !allowedRemoved.has(a.anchor));
    if (unclaimedAnchors.length) {
      const total = unclaimedAnchors.reduce((n, a) => n + a.openThreads, 0);
      concerns.push(
        `${unclaimedAnchors.length} anchored ${unclaimedAnchors.length === 1 ? 'item is' : 'items are'} ` +
          `deleted while ${unclaimedAnchors.length === 1 ? 'its' : 'their'} story stays, stranding ` +
          `${total} open client comment${total === 1 ? '' : 's'}: ` +
          `${unclaimedAnchors.map((a) => a.anchor).join(', ')}.`,
      );
    }

    // ---- additions: gated only once they stop looking like iteration ----
    const growthLimit = Math.max(GROWTH_FLOOR, Math.ceil(liveRows.length * GROWTH_FRACTION));
    if (added.length > growthLimit) {
      const unclaimed = addedGroups.filter((g) => !allowedAdded.has(g.group));
      if (unclaimed.length) {
        concerns.push(
          `${added.length} stories are added to a surface of ${liveRows.length} — past the ${growthLimit} ` +
            `that passes without asking. Unclaimed: ` +
            `${unclaimed.map((g) => `${g.group} (${g.count})`).join(', ')}.`,
        );
      }
    }

    return {
      liveBuild: { id: live.id, label: live.label },
      added,
      removed,
      addedGroups,
      removedGroups,
      droppedAnchors,
      unmatchedClaims,
      groupMismatches,
      liveCount: liveRows.length,
      incomingCount: incoming.length,
      concerns,
    };
  }

  ingestBuildZip(
    zipBytes: Uint8Array,
    meta: { label: string; gitSha?: string } & UploadClaims,
    by: Principal,
  ): BuildUploadResult {
    const entries = readZip(zipBytes);
    const hash = manifestHash(entries);

    const existing = this.db
      .prepare('SELECT * FROM builds WHERE manifest_hash = ?')
      .get(hash) as BuildRow | undefined;
    if (existing) {
      return { build: rowToBuild(existing), created: false, newStories: 0, delta: null };
    }

    const stories = parseStoryIndex(entries);

    /*
     * THE GATE, AND IT IS BEFORE ANY WRITE ON PURPOSE.
     *
     * Computed here rather than in the CLI because the CLI is not the only caller — the
     * MCP server and any agent with an admin key post to this route directly, and a check
     * that lives in one client protects only that client. The same reasoning retired the
     * addon's trust-the-client build id.
     *
     * A refused upload must leave nothing behind: no extracted tree, no build row. So the
     * throw happens before `writeEntries`, not inside the transaction that would roll the
     * row back but not the files.
     */
    const delta = this.storyDelta(stories, meta, parseAnchorManifest(entries));
    if (delta.concerns.length && !meta.allowStoryChanges) {
      throw new HttpError(
        409,
        `Upload would change the reviewable surface. ${delta.concerns.join(' ')}`,
        'story-set-changed',
        delta,
      );
    }

    const buildId = id();
    // Recorded relative to the data directory, resolved against it on read. An absolute
    // path survives a backup and restore only while the data directory keeps its old
    // location: restore onto a new host or a renamed mount and the review history loads
    // perfectly while every asset of every build 404s — a restore that looks like it
    // worked and is not.
    const storagePath = path.join('builds', buildId);
    writeEntries(entries, path.resolve(this.dataDir, storagePath));

    let newStories = 0;
    const at = nowIso();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO builds (id, manifest_hash, label, git_sha, story_count, storage_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(buildId, hash, meta.label, meta.gitSha ?? null, stories.length, storagePath, at);

      const getStory = this.db.prepare('SELECT * FROM stories WHERE story_id = ?');
      const insertStory = this.db.prepare(
        `INSERT INTO stories (story_id, title, component_title, import_path, kind, state, anchor_build_id, last_seen_build_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'in_review', NULL, ?, ?)`,
      );
      // Kind is refreshed too: adding or removing the sheet tag reclassifies the story
      // on the next upload rather than stranding it in whatever it was first seen as.
      const refreshStory = this.db.prepare(
        'UPDATE stories SET title = ?, component_title = ?, import_path = ?, kind = ?, last_seen_build_id = ? WHERE story_id = ?',
      );

      for (const s of stories) {
        const existingStory = getStory.get(s.storyId) as StoryRow | undefined;
        if (!existingStory) {
          insertStory.run(
            s.storyId,
            s.title,
            s.componentTitle ?? '',
            s.importPath,
            s.kind,
            buildId,
            at,
          );
          this.insertEvent(s.storyId, null, 'in_review', by, {
            buildId,
            note: `First seen in build "${meta.label}".`,
          });
          newStories++;
          continue;
        }
        refreshStory.run(s.title, s.componentTitle ?? '', s.importPath, s.kind, buildId, s.storyId);
        // A sheet is not a review unit, so a new build never puts one in the
        // re-confirm queue — its status is a rollup over members that recompute
        // themselves. Without this guard every sheet would land in "needs your
        // attention" on every upload.
        if (s.kind === 'sheet') continue;
        /*
         * A new build does NOT unsettle an approval. Only a changed render does, and
         * that is decided later, in putRenderReport, once there is evidence.
         *
         * The unit of review is the story, not the build. A reviewer approving a
         * component is recording a judgement about that component as they saw it —
         * Greenroom is the notebook, not the subject. Unsettling on build identity meant
         * anything at all shipping in the bundle revoked their decision: a change to
         * another component, a dependency bump, or Greenroom's own addon being rebuilt.
         * None of those alter the thing they looked at, and no reviewer can construct a
         * reason why they should. Asked to re-affirm hundreds of untouched components,
         * they stop looking — which manufactures exactly the hollow approvals that
         * pinning to a build was meant to prevent.
         *
         * Supersedes the 2026-08-11 ratification ("new build → needs_reconfirm").
         * What that decision was protecting — never showing a sign-off for markup nobody
         * signed off — is now enforced where the evidence actually lives: a story whose
         * render hash differs from the one at its anchor is demoted on sight.
         */
      }
    })();

    const build = this.getBuild(buildId);
    return { build, created: true, newStories, delta };
  }

  /**
   * Newest first. `rowid` breaks the tie because `created_at` is millisecond ISO and two
   * builds can land inside one millisecond — a scripted double upload, a CI job pushing
   * a rebuild, a test. Without the tiebreaker SQLite is free to return either, and the
   * one it picked was the OLDER build: `changedSinceApproval` then compared a story
   * against the build it was approved on and reported no change forever, approvals
   * pinned to a superseded build, and `/review/:token` could land a reviewer on it.
   * Build ids are random UUIDs, so insertion order is the only thing that can order them.
   */
  listBuilds(): Build[] {
    return (
      this.db.prepare('SELECT * FROM builds ORDER BY created_at DESC, rowid DESC').all() as BuildRow[]
    ).map(rowToBuild);
  }

  getBuild(buildId: string): Build {
    const row = this.db.prepare('SELECT * FROM builds WHERE id = ?').get(buildId) as
      | BuildRow
      | undefined;
    if (!row) throw new HttpError(404, `Build ${buildId} not found.`);
    return rowToBuild(row);
  }

  latestBuild(): Build | null {
    const row = this.db
      .prepare('SELECT * FROM builds ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get() as BuildRow | undefined;
    return row ? rowToBuild(row) : null;
  }

  /** Absolute path of a file inside a build's extracted tree, traversal-safe. */
  buildFilePath(buildId: string, relPath: string): string {
    const build = this.getBuild(buildId);
    // Resolved against the data directory. `path.resolve` ignores the base when the
    // stored value is already absolute, so a row the v4 migration did not rewrite — a
    // path written in some shape it did not recognise — still resolves as it always did.
    const stored = (
      this.db.prepare('SELECT storage_path FROM builds WHERE id = ?').get(build.id) as {
        storage_path: string;
      }
    ).storage_path;
    const root = path.resolve(this.dataDir, stored);
    const resolved = path.resolve(root, relPath === '' ? 'index.html' : relPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new HttpError(400, 'Invalid path.');
    }
    return resolved;
  }

  // ── stories + status ──────────────────────────────────────────────────────

  /**
   * `kind` defaults to every story, because the reviewer shell needs sheets — they are
   * the surface it navigates. Consumers that must never see a sheet (above all the
   * agent's work queue, where a sheet would send an agent to edit the review instrument
   * instead of the product) pass `kind: 'story'` explicitly.
   */
  listStories(
    filter: { state?: StoryState; kind?: StoryKind } = {},
  ): (Story & {
    openThreads: number;
    unresolvedThreads: number;
    changedSinceApproval: boolean;
  })[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.state) {
      where.push('state = ?');
      params.push(filter.state);
    }
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    const sql = `SELECT * FROM stories${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY story_id`;
    const rows = this.db.prepare(sql).all(...params) as StoryRow[];
    const openCount = this.db.prepare(
      "SELECT COUNT(*) AS n FROM threads WHERE story_id = ? AND state = 'open'",
    );
    // A sheet's own bubble must roll up its tiles. Routed comments live on the
    // component, so counting only `story_id = sheet` would show a page the reviewer
    // has commented on twelve times as having nothing on it — and send them hunting
    // through the component list for their own words, which is the problem contact
    // sheets exist to remove.
    // Distinct from openThreads on purpose. `open` drives the reviewer's attention
    // badge; `unresolved` is what blocks approval, and it includes threads an agent has
    // marked addressed but nobody has accepted. Collapsing the two would either inflate
    // the badge or let a sign-off through over an unaccepted fix.
    const unresolvedCount = this.db.prepare(
      "SELECT COUNT(*) AS n FROM threads WHERE story_id = ? AND state != 'resolved'",
    );
    const openRollup = this.db.prepare(
      `SELECT COUNT(*) AS n FROM threads WHERE state = 'open'
         AND (story_id = ? OR seen_on_story_id = ? OR story_id IN
              (SELECT member_story_id FROM sheet_members WHERE sheet_story_id = ?))`,
    );
    return rows.map((r) => {
      const story = rowToStory(r);
      const counter =
        story.kind === 'sheet'
          ? (openRollup.get(r.story_id, r.story_id, r.story_id) as { n: number })
          : (openCount.get(r.story_id) as { n: number });
      return {
        ...story,
        openThreads: counter.n,
        unresolvedThreads: (unresolvedCount.get(r.story_id) as { n: number }).n,
        changedSinceApproval: this.changedSinceApproval(story),
      };
    });
  }

  getStory(storyId: string): Story {
    const row = this.db.prepare('SELECT * FROM stories WHERE story_id = ?').get(storyId) as
      | StoryRow
      | undefined;
    if (!row) throw new HttpError(404, `Story ${storyId} not found.`);
    return rowToStory(row);
  }

  agentApprovalPolicy(): AgentApprovalPolicy {
    return this.activeDelegation() ? 'delegated' : 'disabled';
  }

  setStoryState(
    storyId: string,
    to: StoryState,
    by: Principal,
    opts: { buildId?: string; note?: string; batchOf?: string } = {},
  ): Story {
    const story = this.getStory(storyId);

    // A contact sheet surveys other stories; it is not a review unit. Approving one
    // would write a human sign-off for a surface that reviews nothing, while the
    // components it shows sit unapproved — and the audit export could not tell the
    // difference. Its status is a rollup, computed from members, never stored here.
    if (story.kind === 'sheet') {
      throw new HttpError(
        400,
        `"${story.title}" is a contact sheet, not a reviewable item — approve the components it shows instead.`,
        'NOT_A_REVIEW_UNIT',
      );
    }

    const policy = this.agentApprovalPolicy();
    const decision = canTransition(by.kind, story.state, to, {
      policy,
      reviewerRole: by.role,
    });
    if (!decision.allowed) {
      throw new HttpError(403, decision.message ?? 'Transition not allowed.', decision.reason);
    }

    // A provided build id must exist — otherwise the anchor FK throws a raw 500
    // on approve, and non-approve transitions would write a bogus id into the
    // append-only audit trail with no FK to catch it.
    if (opts.buildId !== undefined) this.getBuild(opts.buildId);

    const buildId = opts.buildId ?? story.lastSeenBuildId;
    let approvalMode: ApprovalMode | null = null;
    let delegationId: string | null = null;
    if (to === 'approved') {
      // Approval binds to the build the reviewer actually saw. A stale client
      // approving against a superseded build would forge a green signature for
      // markup that has since changed — reject and force a reload.
      if (buildId !== story.lastSeenBuildId) {
        throw new HttpError(
          409,
          'A newer build has been uploaded — reload the review before approving so your sign-off pins to what you are looking at.',
          'STALE_BUILD',
        );
      }
      // An unresolved thread is an objection that has not been answered. Signing off
      // over the top of one produces a green story with an open complaint attached to
      // it — the audit trail then says approved while the review says otherwise, and
      // whoever raised it has no way to know their point was passed over. Resolving is
      // cheap and deliberate; approving around it must not be possible, from the panel,
      // the shell, or an agent.
      // Per variant, not across the component. A comment about the spinner on `Loading`
      // is not an objection to `Primary`, and refusing the whole component over it is
      // the kind of blanket refusal a reviewer reads as the tool being obstructive.
      // What must not happen is a sign-off landing on the variant the comment is about.
      // Re-confirming an approval is only meaningful when the render actually moved.
      // Allowing it otherwise would let a client write unlimited identical sign-offs
      // into an append-only trail, each one indistinguishable from a real re-look.
      // Asked at the COMPONENT: the reviewer re-confirms the component, and which
      // variant's id the panel happened to send is an implementation detail — checking
      // only that one would refuse whenever the change landed on a sibling.
      if (story.state === 'approved' && !this.componentChanged(story)) {
        throw new HttpError(
          409,
          `"${this.componentLabel(story)}" is already approved and has not changed since.`,
          'NOTHING_CHANGED',
        );
      }
      const eligible = this.componentStories(story).filter(
        (m) => this.unresolvedCount(m.storyId) === 0,
      );
      if (eligible.length === 0) {
        const n = this.unresolvedCount(story.storyId);
        throw new HttpError(
          409,
          `"${this.componentLabel(story)}" has ${n} unresolved comment${n === 1 ? '' : 's'} — resolve ${n === 1 ? 'it' : 'them'} before approving.`,
          'OPEN_THREADS',
        );
      }

      approvalMode = by.kind === 'agent' ? 'delegated' : 'direct';
      if (approvalMode === 'delegated') delegationId = this.activeDelegation()!.id;
      // A batch member was never opened. Recording it as `direct` would put a look that
      // did not happen into the trail; `batch` says what occurred and names the one
      // component that did get looked at.
      if (opts.batchOf) {
        if (by.kind === 'agent') {
          throw new HttpError(
            403,
            'Batch approval is a human convenience. An agent must name every story it approves.',
            'AGENT_BATCH_FORBIDDEN',
          );
        }
        approvalMode = 'batch';
      }
    }

    // The decision covers the component, so it is written across every variant of it,
    // in one transaction. Each variant still gets its own audit row — the trail stays
    // answerable per story — carrying a note that names what was actually reviewed and
    // how many renditions the decision covered.
    // Approving covers the component's variants EXCEPT any carrying an unanswered
    // comment: those are left where they are and reported, rather than swept along.
    const all = this.componentStories(story);
    const members =
      to === 'approved' ? all.filter((m) => this.unresolvedCount(m.storyId) === 0) : all;
    const scope =
      members.length > 1
        ? `Reviewed as component "${this.componentLabel(story)}" (${members.length} variants).`
        : undefined;
    // Deliberately makes no causal claim. It does not say this component changed
    // BECAUSE of the one reviewed — nothing here knows that, and asserting it would be
    // inventing a dependency graph out of a coincidence of timing. It says only what is
    // true: both were flagged in the same build, and the reviewer looked at that one.
    const batch = opts.batchOf
      ? `Approved as part of a batch after reviewing "${this.componentLabel(
          this.getStory(opts.batchOf),
        )}"; also flagged as changed in this build, not individually inspected.`
      : undefined;
    this.db.transaction(() => {
      for (const m of members) {
        // A re-confirmation leaves the state where it is and moves the anchor forward,
        // so "same state" is no longer the same as "nothing to do". Skipping on state
        // alone made re-approval silently do nothing: the anchor stayed on the old
        // build, the change flag never cleared, and the button appeared broken.
        const anchorMoves = to === 'approved' && m.anchorBuildId !== buildId;
        if (m.state === to && !anchorMoves) continue;
        this.db
          .prepare('UPDATE stories SET state = ?, anchor_build_id = ? WHERE story_id = ?')
          .run(to, to === 'approved' ? buildId : m.anchorBuildId, m.storyId);
        this.insertEvent(m.storyId, m.state, to, by, {
          buildId,
          note: [opts.note, scope, batch].filter(Boolean).join(' ') || undefined,
          approvalMode,
          delegationId,
        });
      }
    })();

    return this.getStory(storyId);
  }

  private insertEvent(
    storyId: string,
    from: StoryState | null,
    to: StoryState,
    by: Principal,
    opts: {
      buildId?: string | null;
      note?: string | null;
      approvalMode?: ApprovalMode | null;
      delegationId?: string | null;
    } = {},
  ) {
    this.db
      .prepare(
        `INSERT INTO status_events
           (id, story_id, from_state, to_state, principal_kind, principal_id, principal_name,
            approval_mode, delegation_id, build_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id(),
        storyId,
        from,
        to,
        by.kind,
        by.id,
        by.name,
        opts.approvalMode ?? null,
        opts.delegationId ?? null,
        opts.buildId ?? null,
        opts.note ?? null,
        nowIso(),
      );
  }

  listEvents(storyId?: string): StatusEvent[] {
    const rows = storyId
      ? (this.db
          .prepare('SELECT * FROM status_events WHERE story_id = ? ORDER BY created_at, id')
          .all(storyId) as EventRow[])
      : (this.db.prepare('SELECT * FROM status_events ORDER BY created_at, id').all() as EventRow[]);
    return rows.map(rowToEvent);
  }

  // ── threads + messages ────────────────────────────────────────────────────

  /**
   * `regionStoryId` is the tile the reviewer clicked. When it resolves to a story in
   * this build, the thread is ATTRIBUTED to that component — its own thread, next to
   * everything else about it, cleared when it is approved — and the surface the
   * reviewer was standing on is recorded as `seenOn`.
   *
   * An unresolved region is not an error and never rejects the comment: a reviewer who
   * has typed something must not lose it because a tile id in host markup went stale.
   * The thread falls back to the surface itself, which is where a comment about the
   * page as a whole belongs anyway.
   */
  createThread(
    input: {
      storyId: string;
      regionStoryId?: string | null;
      buildId: string;
      body: string;
      pin?: Pin;
      args?: Record<string, unknown>;
      screenshotAttachmentId?: string;
    },
    by: Principal,
  ): FeedbackItem {
    const surface = this.getStory(input.storyId);
    this.getBuild(input.buildId);

    let targetStoryId = input.storyId;
    let seenOn: string | null = null;
    if (input.regionStoryId && input.regionStoryId !== input.storyId) {
      const region = this.db
        .prepare('SELECT 1 FROM stories WHERE story_id = ? AND last_seen_build_id = ?')
        .get(input.regionStoryId, input.buildId);
      if (region) {
        targetStoryId = input.regionStoryId;
        seenOn = input.storyId;
      }
    }
    // A comment left directly on a sheet — not on any tile — still belongs to the sheet,
    // and seenOn records that plainly rather than leaving it to be inferred.
    if (seenOn === null && surface.kind === 'sheet') seenOn = input.storyId;

    // A screenshot reference must point at a real attachment row — never accept
    // an arbitrary client-supplied string (it is later rendered in an <img src>).
    if (input.screenshotAttachmentId !== undefined) this.getAttachment(input.screenshotAttachmentId);
    const threadId = id();
    const at = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO threads
             (id, story_id, seen_on_story_id, build_id, state, selector, x, y, viewport_w, viewport_h,
              viewport_label, args_json, screenshot_attachment_id, created_by_kind, created_by_id,
              created_by_name, created_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          targetStoryId,
          seenOn,
          input.buildId,
          input.pin?.selector ?? null,
          input.pin?.x ?? null,
          input.pin?.y ?? null,
          input.pin?.viewportWidth ?? null,
          input.pin?.viewportHeight ?? null,
          input.pin?.viewportLabel ?? null,
          input.args ? JSON.stringify(input.args) : null,
          input.screenshotAttachmentId ?? null,
          by.kind,
          by.id,
          by.name,
          at,
        );
      this.insertMessage(threadId, by, 'comment', input.body);
    })();
    return this.getFeedbackItem(threadId);
  }

  addMessage(threadId: string, by: Principal, kind: MessageKind, body: string): Message {
    this.getThreadRow(threadId);
    return this.insertMessage(threadId, by, kind, body);
  }

  private insertMessage(threadId: string, by: Principal, kind: MessageKind, body: string): Message {
    const msg: Message = {
      id: id(),
      threadId,
      author: by,
      kind,
      body,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, thread_id, author_kind, author_id, author_name, kind, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(msg.id, threadId, by.kind, by.id, by.name, kind, body, msg.createdAt);
    return msg;
  }

  setThreadState(threadId: string, state: ThreadState, by: Principal, note?: string): FeedbackItem {
    this.getThreadRow(threadId);
    this.db.transaction(() => {
      this.db.prepare('UPDATE threads SET state = ? WHERE id = ?').run(state, threadId);
      this.insertMessage(threadId, by, 'status_change', note ?? `Thread marked ${state}.`);
    })();
    return this.getFeedbackItem(threadId);
  }

  /**
   * Asking for a SHEET's feedback returns everything a reviewer standing on that sheet
   * should see, which is deliberately wider than `story_id = ?`:
   *
   *   - threads on the sheet itself (a comment about the page as a whole),
   *   - threads left while on this sheet but attributed to a tile (`seen_on`), and
   *   - threads on any story this sheet surveys, whoever raised them and wherever.
   *
   * The second is what stops a reviewer's own comment disappearing the instant they
   * post it. The third is what stops a second reviewer, arriving via a different sheet
   * that shows the same component, from seeing a clean tile and approving over an open
   * flag someone else raised.
   */
  listFeedback(filter: { storyId?: string; threadState?: ThreadState } = {}): FeedbackItem[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.storyId) {
      const surface = this.db
        .prepare('SELECT kind FROM stories WHERE story_id = ?')
        .get(filter.storyId) as { kind: string } | undefined;
      if (surface?.kind === 'sheet') {
        clauses.push(
          `(story_id = ? OR seen_on_story_id = ? OR story_id IN
             (SELECT member_story_id FROM sheet_members WHERE sheet_story_id = ?))`,
        );
        params.push(filter.storyId, filter.storyId, filter.storyId);
      } else {
        clauses.push('story_id = ?');
        params.push(filter.storyId);
      }
    }
    if (filter.threadState) {
      clauses.push('state = ?');
      params.push(filter.threadState);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT id FROM threads ${where} ORDER BY created_at, id`)
      .all(...params) as { id: string }[];
    return rows.map((r) => this.getFeedbackItem(r.id));
  }

  getFeedbackItem(threadId: string): FeedbackItem {
    const row = this.getThreadRow(threadId);
    const story = this.getStory(row.story_id);
    const messages = (
      this.db
        .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, id')
        .all(threadId) as MessageRow[]
    ).map(rowToMessage);
    return {
      thread: rowToThread(row),
      story: {
        storyId: story.storyId,
        title: story.title,
        // The component is what the comment is actually filed against and what a
        // reviewer or an agent recognises; `title` alone is the variant. Both
        // consumers declared this field before the payload carried it, so both were
        // quietly reading undefined and falling back to the variant name.
        componentTitle: story.componentTitle,
        importPath: story.importPath,
        state: story.state,
      },
      messages,
    };
  }

  private getThreadRow(threadId: string): ThreadRow {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as
      | ThreadRow
      | undefined;
    if (!row) throw new HttpError(404, `Thread ${threadId} not found.`);
    return row;
  }

  // ── fingerprints ──────────────────────────────────────────────────────────

  putFingerprint(storyId: string, buildId: string, hash: string, regionKey = ROOT_REGION) {
    this.getStory(storyId);
    this.getBuild(buildId);
    this.writeFingerprint(storyId, buildId, regionKey, hash, nowIso());
  }

  /**
   * Record a story's whole-root hash together with the per-region hashes observed in
   * the same render, and — for a sheet — the membership that render implies.
   *
   * Membership and per-region hashes come from one traversal at render time because
   * they answer the same question: which stories does this surface show, and has each
   * of them moved. Deriving membership here rather than from a hand-maintained list is
   * what keeps it from rotting; recording it per build is what makes a member that
   * disappears from the codebase visible instead of silently absent.
   */
  putRenderReport(
    storyId: string,
    buildId: string,
    input: { hash: string; regions?: RegionFingerprint[] },
  ): { recorded: number; unresolved: string[] } {
    const story = this.getStory(storyId);
    this.getBuild(buildId);
    const at = nowIso();
    const declared = input.regions ?? [];

    // A region key is a story id living in the HOST's own markup, which Greenroom
    // cannot rewrite. Retitle a component and Storybook regenerates its id, but the
    // string literal in the sheet that names it does not change and the build still
    // succeeds. Accepting it would record membership and a fingerprint for a story
    // absent from this build, then report a confident `changed` verdict computed
    // against nothing — the exact class of confidently-wrong artifact this design
    // exists to prevent. Unresolved regions are dropped and reported instead, so the
    // problem surfaces once at build level rather than as per-tile noise.
    const known = this.db.prepare(
      'SELECT 1 FROM stories WHERE story_id = ? AND last_seen_build_id = ?',
    );
    const regions: RegionFingerprint[] = [];
    const unresolved: string[] = [];
    for (const r of declared) {
      if (r.regionKey === ROOT_REGION) continue;
      if (known.get(r.regionKey, buildId)) regions.push(r);
      else unresolved.push(r.regionKey);
    }

    this.db.transaction(() => {
      this.writeFingerprint(storyId, buildId, ROOT_REGION, input.hash, at);
      for (const r of regions) {
        this.writeFingerprint(storyId, buildId, r.regionKey, r.hash, at);
      }
      if (story.kind !== 'sheet') return;

      // Replace rather than merge: a tile removed from the sheet must disappear from
      // this build's membership, or the rollup keeps counting something nobody can see.
      this.db
        .prepare('DELETE FROM sheet_members WHERE sheet_story_id = ? AND build_id = ?')
        .run(storyId, buildId);
      const insert = this.db.prepare(
        `INSERT INTO sheet_members (sheet_story_id, member_story_id, build_id, position, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      regions.forEach((r, i) => insert.run(storyId, r.regionKey, buildId, i, at));
    })();

    return { recorded: regions.length, unresolved };
  }

  /**
   * Give an approval back when the new build renders exactly what was approved.
   *
   * A new upload unsettles every approval, because at upload time nothing has rendered
   * yet and there is no evidence either way. That default is right. What was wrong was
   * leaving it there: a reviewer who signed off a component and is then asked to sign it
   * off again — with the render byte-identical — has no way to make sense of the request,
   * and a reviewer asked to do that a few hundred times stops looking. Fatigue
   * manufactures exactly the false greens the unsettling was meant to prevent, just via a
   * bored human instead of a bad hash.
   *
   * So the fingerprint is evidence that RESTORES, never evidence that assumes: unsettle
   * first, and hand the approval back only once this build has actually been rendered and
   * hashed to the same value. It is recorded as `carried`, attributed to whoever gave the
   * original sign-off, so an export can always separate "a person looked at this build"
   * from "a person looked at an identical one".
   */

  /**
   * The stories that make up one component — the CSF file's whole export set.
   *
   * The review unit is the component, because that is what a reviewer looks at and
   * decides about. A contact sheet tile is labelled "SideNav" and renders a bespoke
   * composition; the story id behind it is a stand-in picked to satisfy an API. Filing
   * their decision against that one variant recorded a judgement about `Grouped` that
   * nobody made, and left `Flat` and `Collapsed` unreviewed forever.
   *
   * Verified 1:1 with title on a real 639-story build: 186 files, 186 titles, no file
   * carrying two titles and no title spanning two files.
   */
  private componentStories(story: Story): Story[] {
    if (story.kind === 'sheet' || !story.importPath) return [story];
    const rows = this.db
      .prepare("SELECT * FROM stories WHERE import_path = ? AND kind != 'sheet' ORDER BY story_id")
      .all(story.importPath) as StoryRow[];
    return rows.length ? rows.map(rowToStory) : [story];
  }

  /** Comments on this story that nobody has answered. */
  private unresolvedCount(storyId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM threads WHERE story_id = ? AND state != 'resolved'")
        .get(storyId) as { n: number }
    ).n;
  }

  /** What to call the thing being approved, in a sentence a reviewer would recognise. */
  private componentLabel(story: Story): string {
    return story.componentTitle || story.title;
  }

  /**
   * Whether an approved story's render has moved since the build it was approved on.
   *
   * Derived, never stored: it is a comparison of two fingerprints and keeping a column
   * in step with them would only create a second thing to be wrong. Only ever true for
   * an approved story — an unreviewed one has no sign-off for a change to have outrun.
   *
   * This replaces withdrawing the approval. A render moving is not evidence that the
   * reviewer's judgement was wrong, and revoking on sight punished them for things they
   * would call unrelated: another variant of the same component, a base component
   * restyled underneath, a token retuned. What it is evidence of is that the thing on
   * screen is no longer exactly the thing they signed off, and saying so — visibly, and
   * filterably — is the honest report. The export never says a plain "approved" for a
   * story carrying this.
   */
  /**
   * The components, other than the one just reviewed, whose renders have also moved
   * since they were approved. One per component — offering the reviewer thirty-eight
   * rows that are seven components would misrepresent the size of what they are
   * agreeing to.
   */
  alsoChanged(exceptStoryId: string): Story[] {
    const except = this.getStory(exceptStoryId);
    const seen = new Set<string>([except.importPath]);
    const out: Story[] = [];
    for (const s of this.listStories({ kind: 'story' })) {
      if (!s.changedSinceApproval || seen.has(s.importPath)) continue;
      seen.add(s.importPath);
      out.push(s);
    }
    return out;
  }

  /**
   * Approve several changed components on the strength of one that was reviewed.
   *
   * Partial by design: a member carrying an unresolved comment, or one that has stopped
   * being changed since the list was drawn, is skipped and reported rather than failing
   * the run. The alternative is an all-or-nothing button that a single stale row can
   * make permanently unclickable, with nothing on screen saying which row it was.
   */
  batchApprove(
    storyIds: string[],
    by: Principal,
    opts: { buildId: string; becauseOf: string },
  ): { approved: string[]; skipped: { storyId: string; reason: string; message: string }[] } {
    const approved: string[] = [];
    const skipped: { storyId: string; reason: string; message: string }[] = [];
    for (const storyId of storyIds) {
      try {
        this.setStoryState(storyId, 'approved', by, {
          buildId: opts.buildId,
          batchOf: opts.becauseOf,
        });
        approved.push(storyId);
      } catch (err) {
        if (err instanceof HttpError) {
          skipped.push({ storyId, reason: err.reason ?? 'ERROR', message: err.message });
        } else throw err;
      }
    }
    return { approved, skipped };
  }

  /** True when any variant of the component has moved since its approval. The review
   *  unit is the component, so this is the question re-confirmation actually turns on. */
  componentChanged(story: Story): boolean {
    return this.componentStories(story).some((m) => this.changedSinceApproval(m));
  }

  changedSinceApproval(story: Story): boolean {
    if (story.state !== 'approved' || !story.anchorBuildId) return false;
    const latest = this.latestBuild();
    if (!latest || latest.id === story.anchorBuildId) return false;

    const now = this.hashesOn(story.storyId, latest.id);
    const then = this.hashesOn(story.storyId, story.anchorBuildId);

    // Compare like with like. A component hashed as its own story and the same component
    // hashed as a tile on a sheet are different markup — the tile carries the card, the
    // name row, whatever the sheet wraps it in — so the two hashes never match even when
    // nothing changed. Comparing across sources would report a change on every component
    // a reviewer happened to open directly after seeing it on a sheet.
    for (const [source, hash] of now) {
      const before = then.get(source);
      if (before !== undefined) return hash !== before;
    }

    // No source recorded on both builds. Unrendered tells us nothing, and guessing would
    // be worse than saying nothing.
    return false;
  }

  /**
   * Every hash recorded for a story on a build, keyed by where it was observed.
   *
   * A story is hashed in two quite different ways, and until now only the first counted:
   *
   *   - as itself, when someone opens its own page      → key `__root__`
   *   - as a tile, when a contact sheet showing it renders → key `sheet:<sheet story id>`
   *
   * The tile hashes were being written all along — `putRenderReport` records one per
   * declared region — but stored under the SHEET's story id, while this check looked
   * only for a root hash under the COMPONENT's id. So the evidence sat in the table and
   * the lookup went somewhere else, and `changedSinceApproval` stayed silent for every
   * component nobody had opened individually on two separate builds. On the reference
   * build that was 634 of 640 stories: the flag was very nearly inert.
   *
   * It matters because sheets are how the review is actually walked. One visit to a
   * contact sheet fingerprints every component on it, so the anchor side comes for free
   * as a by-product of reviewing — which is exactly the pass where the reviewer is
   * approving things.
   *
   * Ordered root-first so a direct render, the sharper evidence, wins when both exist.
   */
  private hashesOn(storyId: string, buildId: string): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT story_id, region_key, hash FROM fingerprints
          WHERE build_id = ? AND ((story_id = ? AND region_key = ?) OR region_key = ?)
          ORDER BY CASE WHEN region_key = ? THEN 0 ELSE 1 END, story_id`,
      )
      .all(buildId, storyId, ROOT_REGION, storyId, ROOT_REGION) as {
      story_id: string;
      region_key: string;
      hash: string;
    }[];
    const out = new Map<string, string>();
    for (const r of rows) {
      out.set(r.region_key === ROOT_REGION ? ROOT_REGION : `sheet:${r.story_id}`, r.hash);
    }
    return out;
  }

  private writeFingerprint(
    storyId: string,
    buildId: string,
    regionKey: string,
    hash: string,
    at: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO fingerprints (story_id, build_id, region_key, hash, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(story_id, build_id, region_key)
           DO UPDATE SET hash = excluded.hash, created_at = excluded.created_at`,
      )
      .run(storyId, buildId, regionKey, hash, at);
  }

  // ── sheet membership ──────────────────────────────────────────────────────

  /** Stories surveyed by a sheet in a given build, in render order. */
  sheetMembers(sheetStoryId: string, buildId: string): SheetMember[] {
    const rows = this.db
      .prepare(
        `SELECT sheet_story_id, member_story_id, build_id, position FROM sheet_members
         WHERE sheet_story_id = ? AND build_id = ? ORDER BY position`,
      )
      .all(sheetStoryId, buildId) as {
      sheet_story_id: string;
      member_story_id: string;
      build_id: string;
      position: number;
    }[];
    return rows.map((r) => ({
      sheetStoryId: r.sheet_story_id,
      memberStoryId: r.member_story_id,
      buildId: r.build_id,
      position: r.position,
    }));
  }

  /**
   * Per-member change verdicts for a sheet: did this tile's render move since that
   * member's own approval was pinned? This is what lets a second review round show
   * only the tiles that actually changed instead of re-presenting the whole sheet.
   *
   * A member with no approval anchor has nothing to compare against and reads
   * `unknown` — never `likely_unchanged`, which would imply a check that never ran.
   */
  sheetRegionVerdicts(
    sheetStoryId: string,
    buildId: string,
  ): { storyId: string; verdict: FingerprintVerdict }[] {
    const fp = this.db.prepare(
      'SELECT hash FROM fingerprints WHERE story_id = ? AND build_id = ? AND region_key = ?',
    );
    const getStory = this.db.prepare('SELECT * FROM stories WHERE story_id = ?');
    return this.sheetMembers(sheetStoryId, buildId).map((m) => {
      const member = getStory.get(m.memberStoryId) as StoryRow | undefined;
      const current = fp.get(sheetStoryId, buildId, m.memberStoryId) as
        | { hash: string }
        | undefined;
      const anchorBuild = member?.anchor_build_id ?? null;
      const anchor = anchorBuild
        ? (fp.get(sheetStoryId, anchorBuild, m.memberStoryId) as { hash: string } | undefined)
        : undefined;
      let verdict: FingerprintVerdict = 'unknown';
      if (current && anchor) verdict = current.hash === anchor.hash ? 'likely_unchanged' : 'changed';
      return { storyId: m.memberStoryId, verdict };
    });
  }

  /** Stories fingerprinted in a build — root hashes only, so per-region rows don't
   * inflate what is meant to read as "how much of this build has been swept". */
  fingerprintCount(buildId: string): number {
    this.getBuild(buildId);
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM fingerprints WHERE build_id = ? AND region_key = ?')
        .get(buildId, ROOT_REGION) as { n: number }
    ).n;
  }


  // ── reviewers, magic links, sessions ──────────────────────────────────────

  createReviewer(input: { name: string; email: string; role?: ReviewerRole }): Reviewer {
    const reviewer: Reviewer = {
      id: id(),
      name: input.name,
      email: input.email,
      role: input.role ?? 'approver',
    };
    this.db
      .prepare('INSERT INTO reviewers (id, name, email, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(reviewer.id, reviewer.name, reviewer.email, reviewer.role, nowIso());
    return reviewer;
  }

  listReviewers(): Reviewer[] {
    return (this.db.prepare('SELECT * FROM reviewers ORDER BY created_at').all() as ReviewerRow[]).map(
      (r) => ({ id: r.id, name: r.name, email: r.email, role: r.role as ReviewerRole }),
    );
  }

  /**
   * Re-point a comment at a host-declared anchor, keeping the way back.
   *
   * The rewrite itself is decided in a browser: the old selector is resolved against a
   * rendered build and the anchor is read off whatever it lands on. That is the only
   * place the question can be answered, and it is also why this stores the original — a
   * pass that resolves a stale positional selector to the wrong card would otherwise
   * cement the error with nothing to undo it.
   *
   * Idempotent, and deliberately one-way about the original: re-anchoring twice keeps
   * the FIRST selector, because that is the one that was true when the reviewer pinned
   * it. Overwriting it on a second pass would quietly lose the only record of where the
   * comment actually started.
   */
  reanchorThread(threadId: string, selector: string): Thread {
    const row = this.getThreadRow(threadId);
    if (!row.selector) {
      throw new HttpError(409, 'This comment has no pin, so there is nothing to re-anchor.', 'NO_PIN');
    }
    if (row.selector !== selector) {
      this.db
        .prepare(
          `UPDATE threads
              SET selector = ?,
                  selector_original = COALESCE(selector_original, selector)
            WHERE id = ?`,
        )
        .run(selector, threadId);
    }
    return rowToThread(this.getThreadRow(threadId));
  }

  /** Put a re-anchored comment back where it was pinned — the escape hatch for a pass
   *  that resolved to the wrong element. */
  restoreThreadAnchor(threadId: string): Thread {
    const row = this.getThreadRow(threadId);
    if (row.selector_original) {
      this.db
        .prepare(
          'UPDATE threads SET selector = selector_original, selector_original = NULL WHERE id = ?',
        )
        .run(threadId);
    }
    return rowToThread(this.getThreadRow(threadId));
  }

  /**
   * Find a reviewer by the address they were invited at, case-insensitively.
   *
   * Only ever used to answer "may this address be sent a link it already had". It cannot
   * create anybody: self-service re-issues access to someone an admin already invited,
   * and an endpoint that could mint a reviewer would be an open door into a client's
   * unreleased design system.
   */
  findReviewerByEmail(email: string): Reviewer | null {
    const row = this.db
      .prepare('SELECT * FROM reviewers WHERE lower(email) = lower(?)')
      .get(email.trim()) as ReviewerRow | undefined;
    return row
      ? { id: row.id, name: row.name, email: row.email, role: row.role as ReviewerRole }
      : null;
  }

  /**
   * Remove a reviewer who never used their link, and everything that let them in.
   *
   * Exists because reviewers accumulate: a smoke test during setup, a throwaway used to
   * check a flow, a name entered twice. Left in the list they are indistinguishable from
   * real people, and a stray one holding `approver` is a live credential for signing off
   * a client's design.
   *
   * 🔴 It REFUSES if the reviewer left any mark — a message or a status event. That is
   * not a safety rail to be worked around; it is the point. Comments and approvals carry
   * the author's name denormalised, so the row survives independently of this table, and
   * deleting the person would leave a trail signed by someone who does not appear in the
   * reviewer list. An audit trail that names people who cannot be looked up is worse than
   * one that names people you would rather were tidier.
   *
   * So this is only ever able to remove someone who has done nothing, which is exactly
   * the case it was written for. Anyone who participated stays, permanently, by design.
   */
  deleteReviewer(reviewerId: string): void {
    const reviewer = this.db
      .prepare('SELECT id, name FROM reviewers WHERE id = ?')
      .get(reviewerId) as { id: string; name: string } | undefined;
    if (!reviewer) throw new HttpError(404, `Reviewer ${reviewerId} not found.`);

    const messages = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE author_kind = 'reviewer' AND author_id = ?")
        .get(reviewerId) as { n: number }
    ).n;
    const events = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM status_events WHERE principal_kind = 'reviewer' AND principal_id = ?",
        )
        .get(reviewerId) as { n: number }
    ).n;

    if (messages || events) {
      throw new HttpError(
        409,
        `${reviewer.name} has taken part — ${messages} comment(s) and ${events} status change(s) — and cannot be removed without orphaning that record.`,
        'reviewer_has_history',
      );
    }

    this.db.transaction(() => {
      /*
       * Retire any token that acted as this person.
       *
       * Revoked AND unbound, in that order of importance. Revoking alone leaves a row
       * pointing at a reviewer about to vanish, and the foreign key refuses the delete
       * with nothing an operator can act on. Unbinding alone is worse: a token with no
       * reviewer authenticates as an AGENT, so deleting a person would silently convert
       * their token into one with different powers rather than stopping it.
       */
      this.db
        .prepare(
          "UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?), reviewer_id = NULL WHERE reviewer_id = ?",
        )
        .run(nowIso(), reviewerId);
      this.db.prepare('DELETE FROM reviewer_progress WHERE reviewer_id = ?').run(reviewerId);
      this.db.prepare('DELETE FROM sessions WHERE reviewer_id = ?').run(reviewerId);
      this.db.prepare('DELETE FROM magic_links WHERE reviewer_id = ?').run(reviewerId);
      this.db.prepare('DELETE FROM reviewers WHERE id = ?').run(reviewerId);
    })();
  }

  /**
   * Delete a thread outright — its messages, and the screenshot it pinned.
   *
   * Normally a thread is resolved, never removed: the record of what was raised and how it
   * was answered is most of what this tool is for. This exists for the narrower case of
   * threads that were never review at all — a comment left while testing the mechanism,
   * on a surface a client is about to open. Resolving those leaves them visible under a
   * filter, which is not the same as them not being there.
   *
   * Admin only, and destructive on purpose: there is no soft-delete to fall back to, so
   * anything removed here is gone. The attachment file is unlinked too, since an orphaned
   * screenshot of a client's unreleased design is worth less than nothing.
   */
  deleteThread(threadId: string): void {
    const row = this.db
      .prepare('SELECT id, screenshot_attachment_id FROM threads WHERE id = ?')
      .get(threadId) as { id: string; screenshot_attachment_id: string | null } | undefined;
    if (!row) throw new HttpError(404, `Thread ${threadId} not found.`);

    const attachment = row.screenshot_attachment_id
      ? (this.db
          .prepare('SELECT file_path FROM attachments WHERE id = ?')
          .get(row.screenshot_attachment_id) as { file_path: string } | undefined)
      : undefined;

    this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId);
      this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
      if (row.screenshot_attachment_id) {
        this.db.prepare('DELETE FROM attachments WHERE id = ?').run(row.screenshot_attachment_id);
      }
    })();

    // Outside the transaction: a failed unlink must not roll back the delete. A file left
    // on disk is untidy; a thread the client can still see is the thing being fixed.
    if (attachment) {
      try {
        fs.unlinkSync(attachment.file_path);
      } catch {
        /* already gone, or never written */
      }
    }
  }

  createMagicLink(reviewerId: string, expiresAt?: string): string {
    const reviewer = this.db.prepare('SELECT id FROM reviewers WHERE id = ?').get(reviewerId);
    if (!reviewer) throw new HttpError(404, `Reviewer ${reviewerId} not found.`);
    const token = secret(24);
    this.db
      .prepare('INSERT INTO magic_links (token, reviewer_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, reviewerId, nowIso(), expiresAt ?? null);
    return token;
  }

  /**
   * Every link, newest first, with the reviewer it belongs to and its live sessions.
   *
   * The token is deliberately NOT returned in full. It is the credential, and a listing
   * that prints it dumps working credentials into terminal scrollback, shell history and
   * anyone's screenshot. A prefix is enough to identify a row for revocation and useless
   * for reaching the review — and an admin who needs a working link can mint one, which
   * is both easier and leaves a record.
   */
  listMagicLinks(opts: { reviewerId?: string; includeInactive?: boolean } = {}): MagicLinkSummary[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.reviewerId) {
      where.push('m.reviewer_id = ?');
      params.push(opts.reviewerId);
    }
    if (!opts.includeInactive) where.push('m.revoked_at IS NULL');
    const rows = this.db
      .prepare(
        `SELECT m.*, r.name AS reviewer_name, r.email AS reviewer_email,
                (SELECT COUNT(*) FROM sessions s
                  WHERE s.magic_link_token = m.token AND s.expires_at > ?) AS live_sessions
           FROM magic_links m JOIN reviewers r ON r.id = m.reviewer_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY m.created_at DESC`,
      )
      .all(nowIso(), ...params) as (MagicLinkRow & {
      reviewer_name: string;
      reviewer_email: string;
      live_sessions: number;
    })[];
    const now = nowIso();
    return rows.map((r) => ({
      tokenPrefix: r.token.slice(0, TOKEN_PREFIX_LEN),
      reviewer: { id: r.reviewer_id, name: r.reviewer_name, email: r.reviewer_email },
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
      liveSessions: r.live_sessions,
      // Stated rather than left for the caller to derive, because "why is this link not
      // working" is the question this listing exists to answer.
      active: !r.revoked_at && !(r.expires_at && r.expires_at < now),
    }));
  }

  /**
   * Withdraw a link, and end the access it granted.
   *
   * Setting `revoked_at` alone stops future redemptions and nothing else. Whoever the
   * link reached keeps a session for up to thirty days, which is the whole window the
   * revocation was meant to close. So the sessions this link minted are ended with it.
   *
   * Sessions created before v8 carry no link attribution and cannot be matched. They are
   * counted and reported rather than swept up silently: ending every session the reviewer
   * has would log out someone legitimately holding a different link, and that is a
   * decision for the person revoking, not a default. `endAllSessions` is how they take it.
   */
  revokeMagicLink(
    prefixOrToken: string,
    opts: { endAllSessions?: boolean } = {},
  ): { reviewer: Reviewer; sessionsEnded: number; unattributedSessions: number } {
    const row = this.resolveMagicLink(prefixOrToken);
    const reviewerRow = this.db
      .prepare('SELECT * FROM reviewers WHERE id = ?')
      .get(row.reviewer_id) as ReviewerRow;
    const now = nowIso();
    let sessionsEnded = 0;
    let unattributedSessions = 0;
    this.db.transaction(() => {
      // Idempotent: revoking an already-revoked link still ends any session that
      // somehow outlived it, and does not overwrite when the withdrawal happened.
      if (!row.revoked_at) {
        this.db.prepare('UPDATE magic_links SET revoked_at = ? WHERE token = ?').run(now, row.token);
      }
      sessionsEnded = this.db
        .prepare('DELETE FROM sessions WHERE magic_link_token = ?')
        .run(row.token).changes;
      if (opts.endAllSessions) {
        sessionsEnded += this.db
          .prepare('DELETE FROM sessions WHERE reviewer_id = ? AND magic_link_token IS NULL')
          .run(row.reviewer_id).changes;
      } else {
        unattributedSessions = (
          this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM sessions
                WHERE reviewer_id = ? AND magic_link_token IS NULL AND expires_at > ?`,
            )
            .get(row.reviewer_id, now) as { n: number }
        ).n;
      }
    })();
    return {
      reviewer: {
        id: reviewerRow.id,
        name: reviewerRow.name,
        email: reviewerRow.email,
        role: reviewerRow.role as ReviewerRole,
      },
      sessionsEnded,
      unattributedSessions,
    };
  }

  /** Resolve a prefix to exactly one link, or refuse. Ambiguity must never be guessed
   *  at — revoking the wrong reviewer's access is worse than making someone retype. */
  private resolveMagicLink(prefixOrToken: string): MagicLinkRow {
    const needle = prefixOrToken.trim();
    if (needle.length < 6) {
      throw new HttpError(400, 'Give at least 6 characters of the link to identify it.');
    }
    const rows = this.db
      .prepare('SELECT * FROM magic_links WHERE token LIKE ? ESCAPE ?')
      .all(`${needle.replace(/[%_\\]/g, '\\$&')}%`, '\\') as MagicLinkRow[];
    if (!rows.length) throw new HttpError(404, `No review link starts with "${needle}".`);
    if (rows.length > 1) {
      throw new HttpError(
        409,
        `"${needle}" matches ${rows.length} links — use more characters.`,
        'AMBIGUOUS',
      );
    }
    return rows[0]!;
  }

  /** Agent and admin tokens. The token itself is stored hashed and cannot be shown
   *  again; the id is the handle for revoking one. */
  listTokens(opts: { includeRevoked?: boolean } = {}): TokenSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, name, created_at, revoked_at FROM tokens
          ${opts.includeRevoked ? '' : 'WHERE revoked_at IS NULL'}
          ORDER BY created_at DESC`,
      )
      .all() as Omit<TokenRow, 'token_hash'>[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
    }));
  }

  revokeToken(id: string): TokenSummary {
    const row = this.db.prepare('SELECT * FROM tokens WHERE id = ?').get(id) as TokenRow | undefined;
    if (!row) throw new HttpError(404, `No token with id ${id}.`);
    if (!row.revoked_at) {
      this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ?').run(nowIso(), id);
    }
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      createdAt: row.created_at,
      revokedAt: row.revoked_at ?? nowIso(),
    };
  }

  /** Redeem a magic link into a session id (the cookie value). Links are reusable
   * until revoked/expired — a client may click the same email link many times. */
  redeemMagicLink(token: string): { sessionId: string; reviewer: Reviewer } {
    const row = this.db.prepare('SELECT * FROM magic_links WHERE token = ?').get(token) as
      | MagicLinkRow
      | undefined;
    if (!row || row.revoked_at) throw new HttpError(403, 'This review link is no longer valid.');
    if (row.expires_at && row.expires_at < nowIso()) {
      throw new HttpError(403, 'This review link has expired.');
    }
    const reviewerRow = this.db
      .prepare('SELECT * FROM reviewers WHERE id = ?')
      .get(row.reviewer_id) as ReviewerRow;
    const sessionId = secret(24);
    const at = new Date();
    this.db.transaction(() => {
      this.db.prepare('UPDATE magic_links SET last_used_at = ? WHERE token = ?').run(nowIso(), token);
      this.db
        .prepare('INSERT INTO sessions (id, reviewer_id, created_at, expires_at, magic_link_token) VALUES (?, ?, ?, ?, ?)')
        .run(
          sessionId,
          row.reviewer_id,
          at.toISOString(),
          new Date(at.getTime() + SESSION_TTL_MS).toISOString(),
          // Attribution is what makes the link revocable: ending the access a leaked
          // link granted means knowing which sessions it minted.
          token,
        );
    })();
    return {
      sessionId,
      reviewer: {
        id: reviewerRow.id,
        name: reviewerRow.name,
        email: reviewerRow.email,
        role: reviewerRow.role as ReviewerRole,
      },
    };
  }

  sessionReviewer(sessionId: string): Reviewer | null {
    const row = this.db
      .prepare(
        `SELECT r.* FROM sessions s JOIN reviewers r ON r.id = s.reviewer_id
         WHERE s.id = ? AND s.expires_at > ?`,
      )
      .get(sessionId, nowIso()) as ReviewerRow | undefined;
    return row ? { id: row.id, name: row.name, email: row.email, role: row.role as ReviewerRole } : null;
  }

  // ── tokens (admin/agent API keys) ─────────────────────────────────────────

  /**
   * Mint a token. `reviewerId` makes it act as that person rather than as an agent —
   * for the operator driving the MCP from their own session, where every action is
   * proposed and confirmed before it lands.
   */
  createToken(
    kind: 'admin' | 'agent',
    name: string,
    reviewerId?: string,
  ): { id: string; token: string } {
    if (reviewerId && !this.db.prepare('SELECT 1 FROM reviewers WHERE id = ?').get(reviewerId)) {
      throw new HttpError(404, `Reviewer ${reviewerId} not found.`);
    }
    const raw = `gr_${kind}_${secret(24)}`;
    const tokenId = id();
    this.db
      .prepare(
        'INSERT INTO tokens (id, token_hash, kind, name, created_at, reviewer_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(tokenId, sha256Hex(raw), kind, name, nowIso(), reviewerId ?? null);
    return { id: tokenId, token: raw };
  }

  /**
   * Resolve a raw token to the principal it acts as.
   *
   * A token bound to a reviewer produces THAT reviewer — id, name and role — so every
   * existing gate keeps working unchanged. The approval check was always on the role
   * rather than the token kind, so a token acting as a comment-only reviewer still
   * cannot sign anything off.
   *
   * A reviewer who has since been deleted yields nothing rather than falling back to an
   * agent principal: a token naming somebody who no longer exists should stop working,
   * not quietly become something with different powers.
   */
  findToken(raw: string): Principal | null {
    const row = this.db
      .prepare('SELECT * FROM tokens WHERE token_hash = ? AND revoked_at IS NULL')
      .get(sha256Hex(raw)) as TokenRow | undefined;
    if (!row) return null;
    if (row.reviewer_id) {
      const reviewer = this.db
        .prepare('SELECT * FROM reviewers WHERE id = ?')
        .get(row.reviewer_id) as ReviewerRow | undefined;
      if (!reviewer) return null;
      return {
        kind: 'reviewer',
        id: reviewer.id,
        name: reviewer.name,
        role: reviewer.role as ReviewerRole,
      };
    }
    return { kind: row.kind as 'admin' | 'agent', id: row.id, name: row.name };
  }

  // ── delegations ───────────────────────────────────────────────────────────

  createDelegation(authorizationNote: string, by: Principal): Delegation {
    if (!authorizationNote.trim()) {
      throw new HttpError(400, 'A delegation requires the written authorization it is based on.');
    }
    const existing = this.activeDelegation();
    if (existing) {
      throw new HttpError(409, 'An active delegation already exists — revoke it first.');
    }
    const delegation: Delegation = {
      id: id(),
      authorizationNote,
      enabledBy: by,
      enabledAt: nowIso(),
      revokedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO delegations (id, authorization_note, enabled_by_kind, enabled_by_id, enabled_by_name, enabled_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(delegation.id, authorizationNote, by.kind, by.id, by.name, delegation.enabledAt);
    return delegation;
  }

  revokeDelegation(delegationId: string) {
    const res = this.db
      .prepare('UPDATE delegations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(nowIso(), delegationId);
    if (!res.changes) throw new HttpError(404, `No active delegation ${delegationId}.`);
  }

  activeDelegation(): Delegation | null {
    const row = this.db
      .prepare('SELECT * FROM delegations WHERE revoked_at IS NULL ORDER BY enabled_at DESC LIMIT 1')
      .get() as DelegationRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      authorizationNote: row.authorization_note,
      enabledBy: { kind: row.enabled_by_kind as Principal['kind'], id: row.enabled_by_id, name: row.enabled_by_name },
      enabledAt: row.enabled_at,
      revokedAt: row.revoked_at,
    };
  }

  listDelegations(): Delegation[] {
    return (
      this.db.prepare('SELECT * FROM delegations ORDER BY enabled_at DESC').all() as DelegationRow[]
    ).map((row) => ({
      id: row.id,
      authorizationNote: row.authorization_note,
      enabledBy: { kind: row.enabled_by_kind as Principal['kind'], id: row.enabled_by_id, name: row.enabled_by_name },
      enabledAt: row.enabled_at,
      revokedAt: row.revoked_at,
    }));
  }

  // ── attachments ───────────────────────────────────────────────────────────

  saveAttachment(bytes: Uint8Array, contentType: string): string {
    const attachmentId = id();
    const dir = path.join(this.dataDir, 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, attachmentId);
    fs.writeFileSync(filePath, bytes);
    this.db
      .prepare(
        'INSERT INTO attachments (id, content_type, file_path, size, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(attachmentId, contentType, filePath, bytes.byteLength, nowIso());
    return attachmentId;
  }

  getAttachment(attachmentId: string): { contentType: string; bytes: Buffer } {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId) as
      | AttachmentRow
      | undefined;
    if (!row) throw new HttpError(404, `Attachment ${attachmentId} not found.`);
    return { contentType: row.content_type, bytes: fs.readFileSync(row.file_path) };
  }

  // ── audit ─────────────────────────────────────────────────────────────────

  auditExport() {
    return {
      exportedAt: nowIso(),
      builds: this.listBuilds(),
      stories: this.listStories(),
      statusEvents: this.listEvents(),
      feedback: this.listFeedback(),
      delegations: this.listDelegations(),
    };
  }
}

// ── row shapes + mappers ────────────────────────────────────────────────────

interface BuildRow {
  id: string;
  manifest_hash: string;
  label: string;
  git_sha: string | null;
  story_count: number;
  storage_path: string;
  created_at: string;
}
interface StoryRow {
  story_id: string;
  title: string;
  component_title: string;
  import_path: string;
  /** Absent on rows read back by pre-v2 code paths in tests; defaults to 'story'. */
  kind: string | null;
  state: string;
  anchor_build_id: string | null;
  last_seen_build_id: string;
  created_at: string;
}
interface ThreadRow {
  id: string;
  story_id: string;
  seen_on_story_id: string | null;
  build_id: string;
  state: string;
  selector: string | null;
  x: number | null;
  y: number | null;
  viewport_w: number | null;
  viewport_label?: string | null;
  selector_original?: string | null;
  viewport_h: number | null;
  args_json: string | null;
  screenshot_attachment_id: string | null;
  created_by_kind: string;
  created_by_id: string;
  created_by_name: string;
  created_at: string;
}
interface MessageRow {
  id: string;
  thread_id: string;
  author_kind: string;
  author_id: string;
  author_name: string;
  kind: string;
  body: string;
  created_at: string;
}
interface EventRow {
  id: string;
  story_id: string;
  from_state: string | null;
  to_state: string;
  principal_kind: string;
  principal_id: string;
  principal_name: string;
  approval_mode: string | null;
  delegation_id: string | null;
  build_id: string | null;
  note: string | null;
  created_at: string;
}
interface ReviewerRow {
  id: string;
  name: string;
  email: string;
  role: string;
  created_at: string;
}
interface MagicLinkRow {
  token: string;
  reviewer_id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}
interface TokenRow {
  id: string;
  token_hash: string;
  kind: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
  reviewer_id?: string | null;
}
interface DelegationRow {
  id: string;
  authorization_note: string;
  enabled_by_kind: string;
  enabled_by_id: string;
  enabled_by_name: string;
  enabled_at: string;
  revoked_at: string | null;
}
interface AttachmentRow {
  id: string;
  content_type: string;
  file_path: string;
  size: number;
  created_at: string;
}

const rowToBuild = (r: BuildRow): Build => ({
  id: r.id,
  manifestHash: r.manifest_hash,
  label: r.label,
  gitSha: r.git_sha,
  storyCount: r.story_count,
  createdAt: r.created_at,
});

const rowToStory = (r: StoryRow): Story => ({
  storyId: r.story_id,
  title: r.title,
  componentTitle: r.component_title ?? '',
  importPath: r.import_path,
  kind: (r.kind ?? 'story') as StoryKind,
  state: r.state as StoryState,
  anchorBuildId: r.anchor_build_id,
  lastSeenBuildId: r.last_seen_build_id,
});

const rowToThread = (r: ThreadRow): Thread => ({
  id: r.id,
  storyId: r.story_id,
  seenOnStoryId: r.seen_on_story_id ?? null,
  buildId: r.build_id,
  state: r.state as ThreadState,
  pin:
    r.selector !== null && r.x !== null && r.y !== null
      ? {
          selector: r.selector,
          x: r.x,
          y: r.y,
          viewportWidth: r.viewport_w ?? 0,
          viewportHeight: r.viewport_h ?? 0,
          viewportLabel: r.viewport_label ?? null,
          /** Where the comment was pinned before a re-anchor pass moved it. Null until
           *  one does, and never overwritten by a later pass. */
          selectorOriginal: r.selector_original ?? null,
        }
      : null,
  args: r.args_json ? (JSON.parse(r.args_json) as Record<string, unknown>) : null,
  screenshotAttachmentId: r.screenshot_attachment_id,
  createdBy: { kind: r.created_by_kind as Principal['kind'], id: r.created_by_id, name: r.created_by_name },
  createdAt: r.created_at,
});

const rowToMessage = (r: MessageRow): Message => ({
  id: r.id,
  threadId: r.thread_id,
  author: { kind: r.author_kind as Principal['kind'], id: r.author_id, name: r.author_name },
  kind: r.kind as MessageKind,
  body: r.body,
  createdAt: r.created_at,
});

const rowToEvent = (r: EventRow): StatusEvent => ({
  id: r.id,
  storyId: r.story_id,
  from: r.from_state as StoryState | null,
  to: r.to_state as StoryState,
  principal: { kind: r.principal_kind as Principal['kind'], id: r.principal_id, name: r.principal_name },
  approvalMode: r.approval_mode as StatusEvent['approvalMode'],
  delegationId: r.delegation_id,
  buildId: r.build_id,
  note: r.note,
  createdAt: r.created_at,
});
