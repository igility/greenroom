/** Per-story review lifecycle. `needs_reconfirm` is the reviewer's queue after a new
 * build invalidates a build-pinned approval; `changes_requested` is the agent's queue. */
export type StoryState =
  | 'in_review'
  | 'changes_requested'
  | 'addressed'
  | 'approved'
  | 'needs_reconfirm';

export type ThreadState = 'open' | 'addressed' | 'resolved';

export type PrincipalKind = 'admin' | 'agent' | 'reviewer';

export type MessageKind = 'comment' | 'agent_note' | 'status_change';

/** How an approval was granted: a direct human action, or an agent acting under a
 * recorded human delegation. Delegated approvals are always audit-labeled. */
export type ApprovalMode = 'direct' | 'delegated';

export type FingerprintVerdict = 'likely_unchanged' | 'changed' | 'unknown';

export interface Principal {
  kind: PrincipalKind;
  /** Reviewer id for reviewers; token id for agent/admin keys. */
  id: string;
  name: string;
  /** Role of a reviewer principal; absent for admin/agent. Gates approval. */
  role?: ReviewerRole;
}

export interface Build {
  id: string;
  /** Content identity: hash over sorted (path, file-hash) pairs of the uploaded
   * storybook-static tree. Identical re-uploads dedupe to the same build. */
  manifestHash: string;
  label: string;
  gitSha: string | null;
  storyCount: number;
  createdAt: string;
}

export interface Story {
  /** Storybook story id, e.g. `components-button--primary`. */
  storyId: string;
  title: string;
  /** CSF file path from the build's index.json — how agents find the source. */
  importPath: string;
  state: StoryState;
  /** Build the current approval is pinned to, when approved. */
  anchorBuildId: string | null;
  lastSeenBuildId: string;
}

/** Where a comment pin landed, captured at comment time. */
export interface Pin {
  selector: string;
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface Thread {
  id: string;
  storyId: string;
  buildId: string;
  state: ThreadState;
  pin: Pin | null;
  /** Story args at comment time. */
  args: Record<string, unknown> | null;
  screenshotAttachmentId: string | null;
  createdBy: Principal;
  createdAt: string;
}

export interface Message {
  id: string;
  threadId: string;
  author: Principal;
  kind: MessageKind;
  body: string;
  createdAt: string;
}

/** Append-only audit record of a story state change. */
export interface StatusEvent {
  id: string;
  storyId: string;
  from: StoryState | null;
  to: StoryState;
  principal: Principal;
  approvalMode: ApprovalMode | null;
  /** For delegated approvals: reference to the recorded authorization. */
  delegationId: string | null;
  buildId: string | null;
  note: string | null;
  createdAt: string;
}

export type ReviewerRole = 'reviewer' | 'approver';

export interface Reviewer {
  id: string;
  name: string;
  email: string;
  role: ReviewerRole;
}

/** A recorded human authorization for agent approvals (off unless one is active). */
export interface Delegation {
  id: string;
  /** The written basis, e.g. "Client email 2026-08-12: approve remaining screens." */
  authorizationNote: string;
  enabledBy: Principal;
  enabledAt: string;
  revokedAt: string | null;
}
