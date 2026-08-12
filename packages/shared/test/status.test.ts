import { describe, expect, it } from 'vitest';
import { AGENT_APPROVAL_WARNING, canTransition } from '../src/status.js';

describe('canTransition', () => {
  it('lets humans walk the review lifecycle', () => {
    expect(canTransition('reviewer', 'in_review', 'changes_requested', 'disabled').allowed).toBe(true);
    expect(canTransition('reviewer', 'in_review', 'approved', 'disabled').allowed).toBe(true);
    expect(canTransition('reviewer', 'needs_reconfirm', 'approved', 'disabled').allowed).toBe(true);
    expect(canTransition('admin', 'approved', 'in_review', 'disabled').allowed).toBe(true);
  });

  it('rejects nonsensical human transitions', () => {
    const d = canTransition('reviewer', 'in_review', 'addressed', 'disabled');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('INVALID_TRANSITION');
  });

  it('lets agents mark requested work addressed without any delegation', () => {
    expect(canTransition('agent', 'changes_requested', 'addressed', 'disabled').allowed).toBe(true);
  });

  it('blocks agent approvals with the warning when no delegation is recorded', () => {
    for (const from of ['in_review', 'addressed', 'needs_reconfirm'] as const) {
      const d = canTransition('agent', from, 'approved', 'disabled');
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('AGENT_APPROVAL_DISABLED');
      expect(d.message).toBe(AGENT_APPROVAL_WARNING);
    }
  });

  it('allows agent approvals under an active delegation', () => {
    expect(canTransition('agent', 'needs_reconfirm', 'approved', 'delegated').allowed).toBe(true);
    expect(canTransition('agent', 'addressed', 'approved', 'delegated').allowed).toBe(true);
  });

  it('never lets agents un-approve or request changes, delegation or not', () => {
    expect(canTransition('agent', 'approved', 'in_review', 'delegated').allowed).toBe(false);
    expect(canTransition('agent', 'in_review', 'changes_requested', 'delegated').allowed).toBe(false);
  });
});
