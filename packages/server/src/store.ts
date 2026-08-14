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
  type StoryState,
  type Thread,
  type ThreadState,
  ROOT_REGION,
} from '@igility/greenroom-shared';
import type { DB } from './db.js';
import { id, nowIso, secret, sha256Hex, HttpError } from './util.js';
import { manifestHash, parseStoryIndex, readZip, writeEntries, type ZipEntries } from './zip.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface BuildUploadResult {
  build: Build;
  created: boolean;
  newStories: number;
  reconfirmed: number;
}

export interface FeedbackItem {
  thread: Thread;
  story: Pick<Story, 'storyId' | 'title' | 'importPath' | 'state'>;
  messages: Message[];
}

export interface ReconfirmItem {
  story: Story;
  verdict: FingerprintVerdict;
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

  ingestBuildZip(zipBytes: Uint8Array, meta: { label: string; gitSha?: string }, by: Principal): BuildUploadResult {
    const entries = readZip(zipBytes);
    const hash = manifestHash(entries);

    const existing = this.db
      .prepare('SELECT * FROM builds WHERE manifest_hash = ?')
      .get(hash) as BuildRow | undefined;
    if (existing) {
      return { build: rowToBuild(existing), created: false, newStories: 0, reconfirmed: 0 };
    }

    const stories = parseStoryIndex(entries);
    const buildId = id();
    // Recorded relative to the data directory, resolved against it on read. An absolute
    // path survives a backup and restore only while the data directory keeps its old
    // location: restore onto a new host or a renamed mount and the review history loads
    // perfectly while every asset of every build 404s — a restore that looks like it
    // worked and is not.
    const storagePath = path.join('builds', buildId);
    writeEntries(entries, path.resolve(this.dataDir, storagePath));

    let newStories = 0;
    let reconfirmed = 0;
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
    return { build, created: true, newStories, reconfirmed };
  }

  listBuilds(): Build[] {
    return (this.db.prepare('SELECT * FROM builds ORDER BY created_at DESC').all() as BuildRow[]).map(
      rowToBuild,
    );
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
      .prepare('SELECT * FROM builds ORDER BY created_at DESC LIMIT 1')
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
  ): (Story & { openThreads: number; unresolvedThreads: number })[] {
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
    opts: { buildId?: string; note?: string } = {},
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
      // Across the whole component: an unanswered objection about any variant is an
      // unanswered objection about the thing being signed off.
      const members = this.componentStories(story);
      const placeholders = members.map(() => '?').join(',');
      const open = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM threads WHERE state != 'resolved' AND story_id IN (${placeholders})`,
        )
        .get(...members.map((m) => m.storyId)) as { n: number };
      if (open.n > 0) {
        throw new HttpError(
          409,
          `"${this.componentLabel(story)}" has ${open.n} unresolved comment${open.n === 1 ? '' : 's'} — resolve ${open.n === 1 ? 'it' : 'them'} before approving.`,
          'OPEN_THREADS',
        );
      }

      approvalMode = by.kind === 'agent' ? 'delegated' : 'direct';
      if (approvalMode === 'delegated') delegationId = this.activeDelegation()!.id;
    }

    // The decision covers the component, so it is written across every variant of it,
    // in one transaction. Each variant still gets its own audit row — the trail stays
    // answerable per story — carrying a note that names what was actually reviewed and
    // how many renditions the decision covered.
    const members = this.componentStories(story);
    const scope =
      members.length > 1
        ? `Reviewed as component "${this.componentLabel(story)}" (${members.length} variants).`
        : undefined;
    this.db.transaction(() => {
      for (const m of members) {
        if (m.state === to) continue;
        this.db
          .prepare('UPDATE stories SET state = ?, anchor_build_id = ? WHERE story_id = ?')
          .run(to, to === 'approved' ? buildId : m.anchorBuildId, m.storyId);
        this.insertEvent(m.storyId, m.state, to, by, {
          buildId,
          note: [opts.note, scope].filter(Boolean).join(' ') || undefined,
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
              args_json, screenshot_attachment_id, created_by_kind, created_by_id, created_by_name, created_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

    this.reconcileApproval(storyId, buildId);
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

  /** What to call the thing being approved, in a sentence a reviewer would recognise. */
  private componentLabel(story: Story): string {
    return story.componentTitle || story.title;
  }

  private reconcileApproval(storyId: string, buildId: string) {
    const story = this.getStory(storyId);
    if (story.kind === 'sheet') return;
    if (!story.anchorBuildId || story.anchorBuildId === buildId) return;

    const fp = this.db.prepare(
      'SELECT hash FROM fingerprints WHERE story_id = ? AND build_id = ? AND region_key = ?',
    );
    const current = fp.get(storyId, buildId, ROOT_REGION) as { hash: string } | undefined;
    const anchor = fp.get(storyId, story.anchorBuildId, ROOT_REGION) as { hash: string } | undefined;
    if (!current || !anchor) return;

    // The render moved under an approval: the sign-off no longer describes what is
    // there, so it is withdrawn on sight. This is where "no false greens" is enforced —
    // on evidence about the story, not on the arrival of a build.
    if (story.state === 'approved' && current.hash !== anchor.hash) {
      // One variant moving means the component moved. The approval covered the
      // component, so it is withdrawn from the component — leaving siblings green
      // because they happen not to have rendered yet would be a sign-off for a
      // component the reviewer would no longer recognise.
      const members = this.componentStories(story).filter((m) => m.state === 'approved');
      this.db.transaction(() => {
        for (const m of members) {
          this.db
            .prepare("UPDATE stories SET state = 'needs_reconfirm' WHERE story_id = ?")
            .run(m.storyId);
          this.insertEvent(m.storyId, 'approved', 'needs_reconfirm', SYSTEM_PRINCIPAL, {
            buildId,
            note:
              m.storyId === storyId
                ? `Render changed since the approved build ${story.anchorBuildId}.`
                : `"${story.title}" changed, and this is part of the same component.`,
          });
        }
      })();
      return;
    }

    if (story.state !== 'needs_reconfirm') return;
    if (current.hash !== anchor.hash) return;

    // Whose sign-off is being carried. Attributing it to nobody would leave an approval
    // with no author; attributing it to a fresh principal would invent one.
    const origin = this.db
      .prepare(
        `SELECT principal_kind, principal_id, principal_name FROM status_events
          WHERE story_id = ? AND to_state = 'approved'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(storyId) as
      | { principal_kind: PrincipalKind; principal_id: string; principal_name: string }
      | undefined;
    if (!origin) return;

    const by: Principal = {
      kind: origin.principal_kind,
      id: origin.principal_id,
      name: origin.principal_name,
    };
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE stories SET state = 'approved', anchor_build_id = ? WHERE story_id = ?")
        .run(buildId, storyId);
      this.insertEvent(storyId, 'needs_reconfirm', 'approved', by, {
        buildId,
        approvalMode: 'carried',
        note: `Carried from build ${story.anchorBuildId} — render identical.`,
      });
    })();
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

  /** Stories awaiting re-confirmation in `buildId`, sorted worst-first, each with a
   * fingerprint verdict. The verdict orders the queue — it never changes state. */
  reconfirmQueue(buildId: string): ReconfirmItem[] {
    this.getBuild(buildId);
    const rows = this.db
      .prepare("SELECT * FROM stories WHERE state = 'needs_reconfirm' AND last_seen_build_id = ?")
      .all(buildId) as StoryRow[];
    const fp = this.db.prepare(
      'SELECT hash FROM fingerprints WHERE story_id = ? AND build_id = ? AND region_key = ?',
    );
    const items = rows.map((r) => {
      const story = rowToStory(r);
      const current = fp.get(story.storyId, buildId, ROOT_REGION) as { hash: string } | undefined;
      const anchor = story.anchorBuildId
        ? (fp.get(story.storyId, story.anchorBuildId, ROOT_REGION) as { hash: string } | undefined)
        : undefined;
      let verdict: FingerprintVerdict = 'unknown';
      if (current && anchor) verdict = current.hash === anchor.hash ? 'likely_unchanged' : 'changed';
      return { story, verdict };
    });
    const rank: Record<FingerprintVerdict, number> = { changed: 0, unknown: 1, likely_unchanged: 2 };
    return items.sort((a, b) => rank[a.verdict] - rank[b.verdict]);
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

  createMagicLink(reviewerId: string, expiresAt?: string): string {
    const reviewer = this.db.prepare('SELECT id FROM reviewers WHERE id = ?').get(reviewerId);
    if (!reviewer) throw new HttpError(404, `Reviewer ${reviewerId} not found.`);
    const token = secret(24);
    this.db
      .prepare('INSERT INTO magic_links (token, reviewer_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, reviewerId, nowIso(), expiresAt ?? null);
    return token;
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
        .prepare('INSERT INTO sessions (id, reviewer_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(
          sessionId,
          row.reviewer_id,
          at.toISOString(),
          new Date(at.getTime() + SESSION_TTL_MS).toISOString(),
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

  createToken(kind: 'admin' | 'agent', name: string): { id: string; token: string } {
    const raw = `gr_${kind}_${secret(24)}`;
    const tokenId = id();
    this.db
      .prepare('INSERT INTO tokens (id, token_hash, kind, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(tokenId, sha256Hex(raw), kind, name, nowIso());
    return { id: tokenId, token: raw };
  }

  findToken(raw: string): { id: string; kind: 'admin' | 'agent'; name: string } | null {
    const row = this.db
      .prepare('SELECT * FROM tokens WHERE token_hash = ? AND revoked_at IS NULL')
      .get(sha256Hex(raw)) as TokenRow | undefined;
    return row ? { id: row.id, kind: row.kind as 'admin' | 'agent', name: row.name } : null;
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
