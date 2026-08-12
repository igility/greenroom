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
  type Reviewer,
  type ReviewerRole,
  type StatusEvent,
  type Story,
  type StoryState,
  type Thread,
  type ThreadState,
} from '@greenroom/shared';
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
    const storagePath = path.join(this.dataDir, 'builds', buildId);
    writeEntries(entries, storagePath);

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
        `INSERT INTO stories (story_id, title, import_path, state, anchor_build_id, last_seen_build_id, created_at)
         VALUES (?, ?, ?, 'in_review', NULL, ?, ?)`,
      );
      const refreshStory = this.db.prepare(
        'UPDATE stories SET title = ?, import_path = ?, last_seen_build_id = ? WHERE story_id = ?',
      );

      for (const s of stories) {
        const existingStory = getStory.get(s.storyId) as StoryRow | undefined;
        if (!existingStory) {
          insertStory.run(s.storyId, s.title, s.importPath, buildId, at);
          this.insertEvent(s.storyId, null, 'in_review', by, {
            buildId,
            note: `First seen in build "${meta.label}".`,
          });
          newStories++;
          continue;
        }
        refreshStory.run(s.title, s.importPath, buildId, s.storyId);
        if (existingStory.state === 'approved' && existingStory.anchor_build_id !== buildId) {
          this.db
            .prepare("UPDATE stories SET state = 'needs_reconfirm' WHERE story_id = ?")
            .run(s.storyId);
          this.insertEvent(s.storyId, 'approved', 'needs_reconfirm', by, {
            buildId,
            note: `Build "${meta.label}" uploaded after approval was pinned to an earlier build.`,
          });
          reconfirmed++;
        }
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
    const root = path.resolve((this.db.prepare('SELECT storage_path FROM builds WHERE id = ?').get(build.id) as { storage_path: string }).storage_path);
    const resolved = path.resolve(root, relPath === '' ? 'index.html' : relPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new HttpError(400, 'Invalid path.');
    }
    return resolved;
  }

  // ── stories + status ──────────────────────────────────────────────────────

  listStories(filter: { state?: StoryState } = {}): (Story & { openThreads: number })[] {
    const rows = filter.state
      ? (this.db.prepare('SELECT * FROM stories WHERE state = ? ORDER BY story_id').all(filter.state) as StoryRow[])
      : (this.db.prepare('SELECT * FROM stories ORDER BY story_id').all() as StoryRow[]);
    const openCount = this.db.prepare(
      "SELECT COUNT(*) AS n FROM threads WHERE story_id = ? AND state = 'open'",
    );
    return rows.map((r) => ({
      ...rowToStory(r),
      openThreads: (openCount.get(r.story_id) as { n: number }).n,
    }));
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
      approvalMode = by.kind === 'agent' ? 'delegated' : 'direct';
      if (approvalMode === 'delegated') delegationId = this.activeDelegation()!.id;
    }

    this.db.transaction(() => {
      this.db
        .prepare('UPDATE stories SET state = ?, anchor_build_id = ? WHERE story_id = ?')
        .run(to, to === 'approved' ? buildId : story.anchorBuildId, storyId);
      this.insertEvent(storyId, story.state, to, by, {
        buildId,
        note: opts.note,
        approvalMode,
        delegationId,
      });
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

  createThread(
    input: {
      storyId: string;
      buildId: string;
      body: string;
      pin?: Pin;
      args?: Record<string, unknown>;
      screenshotAttachmentId?: string;
    },
    by: Principal,
  ): FeedbackItem {
    this.getStory(input.storyId);
    this.getBuild(input.buildId);
    // A screenshot reference must point at a real attachment row — never accept
    // an arbitrary client-supplied string (it is later rendered in an <img src>).
    if (input.screenshotAttachmentId !== undefined) this.getAttachment(input.screenshotAttachmentId);
    const threadId = id();
    const at = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO threads
             (id, story_id, build_id, state, selector, x, y, viewport_w, viewport_h,
              args_json, screenshot_attachment_id, created_by_kind, created_by_id, created_by_name, created_at)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          input.storyId,
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

  listFeedback(filter: { storyId?: string; threadState?: ThreadState } = {}): FeedbackItem[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.storyId) {
      clauses.push('story_id = ?');
      params.push(filter.storyId);
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

  putFingerprint(storyId: string, buildId: string, hash: string) {
    this.getStory(storyId);
    this.getBuild(buildId);
    this.db
      .prepare(
        `INSERT INTO fingerprints (story_id, build_id, hash, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(story_id, build_id) DO UPDATE SET hash = excluded.hash, created_at = excluded.created_at`,
      )
      .run(storyId, buildId, hash, nowIso());
  }

  fingerprintCount(buildId: string): number {
    this.getBuild(buildId);
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM fingerprints WHERE build_id = ?').get(buildId) as {
        n: number;
      }
    ).n;
  }

  /** Stories awaiting re-confirmation in `buildId`, sorted worst-first, each with a
   * fingerprint verdict. The verdict orders the queue — it never changes state. */
  reconfirmQueue(buildId: string): ReconfirmItem[] {
    this.getBuild(buildId);
    const rows = this.db
      .prepare("SELECT * FROM stories WHERE state = 'needs_reconfirm' AND last_seen_build_id = ?")
      .all(buildId) as StoryRow[];
    const fp = this.db.prepare('SELECT hash FROM fingerprints WHERE story_id = ? AND build_id = ?');
    const items = rows.map((r) => {
      const story = rowToStory(r);
      const current = fp.get(story.storyId, buildId) as { hash: string } | undefined;
      const anchor = story.anchorBuildId
        ? (fp.get(story.storyId, story.anchorBuildId) as { hash: string } | undefined)
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
  import_path: string;
  state: string;
  anchor_build_id: string | null;
  last_seen_build_id: string;
  created_at: string;
}
interface ThreadRow {
  id: string;
  story_id: string;
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
  importPath: r.import_path,
  state: r.state as StoryState,
  anchorBuildId: r.anchor_build_id,
  lastSeenBuildId: r.last_seen_build_id,
});

const rowToThread = (r: ThreadRow): Thread => ({
  id: r.id,
  storyId: r.story_id,
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
