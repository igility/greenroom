import type { PrincipalKind, ReviewerRole, StoryState } from './types.js';

/** Server-side policy for agent approvals. Disabled unless an admin has recorded a
 * written human authorization (a Delegation row); then 'delegated'. */
export type AgentApprovalPolicy = 'disabled' | 'delegated';

export interface TransitionDecision {
  allowed: boolean;
  /** Machine-readable reason when denied. */
  reason?:
    | 'AGENT_APPROVAL_DISABLED'
    | 'AGENT_TRANSITION_FORBIDDEN'
    | 'INVALID_TRANSITION'
    | 'REVIEWER_ROLE_FORBIDDEN';
  /** Human/agent-readable explanation when denied. */
  message?: string;
}

export interface TransitionContext {
  policy: AgentApprovalPolicy;
  /** Role of a reviewer principal; approval is an approver-only action. Ignored
   * for admin and agent principals. Defaults to 'approver' when omitted. */
  reviewerRole?: ReviewerRole;
}

export const AGENT_APPROVAL_WARNING =
  'Approval is a human sign-off. An agent may only approve stories when an admin has ' +
  'recorded a written client authorization (a delegation) on the server, the approval is ' +
  'explicitly confirmed, and the result is labeled "approved (delegated)" in the audit ' +
  'trail. If you are unsure whether that authorization exists, stop and ask the human.';

const HUMAN_TRANSITIONS: Record<StoryState, StoryState[]> = {
  in_review: ['changes_requested', 'approved'],
  changes_requested: ['addressed', 'approved', 'in_review'],
  addressed: ['approved', 'changes_requested', 'in_review'],
  approved: ['in_review', 'changes_requested'],
  needs_reconfirm: ['approved', 'changes_requested', 'in_review'],
};

/** Agents may move work into review states, never grant approval on their own. */
const AGENT_TRANSITIONS: Record<StoryState, StoryState[]> = {
  in_review: [],
  changes_requested: ['addressed'],
  addressed: [],
  approved: [],
  needs_reconfirm: [],
};

/** Additional transitions an agent gains under an active recorded delegation. */
const AGENT_DELEGATED_TRANSITIONS: Record<StoryState, StoryState[]> = {
  in_review: ['approved'],
  changes_requested: [],
  addressed: ['approved'],
  approved: [],
  needs_reconfirm: ['approved'],
};

export function canTransition(
  principal: PrincipalKind,
  from: StoryState,
  to: StoryState,
  ctx: TransitionContext,
): TransitionDecision {
  if (principal === 'admin' || principal === 'reviewer') {
    if (!HUMAN_TRANSITIONS[from].includes(to)) {
      return {
        allowed: false,
        reason: 'INVALID_TRANSITION',
        message: `Cannot move a story from "${from}" to "${to}".`,
      };
    }
    // Approval is an approver-only action; a comment-only reviewer cannot sign off.
    if (principal === 'reviewer' && to === 'approved' && ctx.reviewerRole === 'reviewer') {
      return {
        allowed: false,
        reason: 'REVIEWER_ROLE_FORBIDDEN',
        message: 'This reviewer can comment but is not authorized to approve. Ask an approver to sign off.',
      };
    }
    return { allowed: true };
  }

  if (AGENT_TRANSITIONS[from].includes(to)) return { allowed: true };

  if (AGENT_DELEGATED_TRANSITIONS[from].includes(to)) {
    if (ctx.policy === 'delegated') return { allowed: true };
    return {
      allowed: false,
      reason: 'AGENT_APPROVAL_DISABLED',
      message: AGENT_APPROVAL_WARNING,
    };
  }

  return {
    allowed: false,
    reason: 'AGENT_TRANSITION_FORBIDDEN',
    message: `Agents cannot move a story from "${from}" to "${to}".`,
  };
}
