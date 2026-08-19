import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../src/db.js';
import { Store } from '../src/store.js';

/**
 * A token that acts as a named person.
 *
 * Agents are deliberately restricted — no approval without a recorded delegation, no
 * resolving at all — because an agent acting unsupervised should not be able to close a
 * client's objection. That restriction assumes nobody is watching.
 *
 * When the operator drives the MCP from their own session, somebody is: every action is
 * proposed, shown and confirmed before it lands, the same arrangement as an assistant
 * sending mail on their behalf. In that arrangement the record naming the operator is
 * MORE accurate than one naming an agent, not less.
 */

let dataDir: string;
let store: Store;
let approverId: string;
let commenterId: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-actas-'));
  store = new Store(openMemoryDb(), dataDir);
  approverId = store.createReviewer({ name: 'Brad', email: 'brad@igility.io' }).id;
  commenterId = store.createReviewer({
    name: 'Sam',
    email: 'sam@example.com',
    role: 'reviewer',
  }).id;
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('a token bound to a reviewer', () => {
  it('authenticates as that person, not as an agent', () => {
    const { token } = store.createToken('agent', 'brad mcp', approverId);
    expect(store.findToken(token)).toEqual({
      kind: 'reviewer',
      id: approverId,
      name: 'Brad',
      role: 'approver',
    });
  });

  it('carries the role, so the existing approval gate still applies', () => {
    // The gate was always on the role rather than the token kind, which is why binding a
    // token to a person needs no new permission logic — and why a token acting as a
    // comment-only reviewer still cannot sign anything off.
    const { token } = store.createToken('agent', 'sam mcp', commenterId);
    expect(store.findToken(token)?.role).toBe('reviewer');
  });

  it('still acts as an agent when bound to nobody', () => {
    const { token, id } = store.createToken('agent', 'ci');
    expect(store.findToken(token)).toEqual({ kind: 'agent', id, name: 'ci' });
  });

  it('stops working when the person it names is deleted', () => {
    // Falling back to an agent principal would silently change what the token can do.
    // A token naming somebody who no longer exists should stop, not become something else.
    const { token } = store.createToken('agent', 'sam mcp', commenterId);
    store.deleteReviewer(commenterId);
    expect(store.findToken(token)).toBeNull();
  });

  it('refuses to name a reviewer who does not exist', () => {
    expect(() => store.createToken('agent', 'x', 'no-such-reviewer')).toThrowError(/not found/i);
  });

  it('can be revoked like any other token', () => {
    const { id, token } = store.createToken('agent', 'brad mcp', approverId);
    store.revokeToken(id);
    expect(store.findToken(token)).toBeNull();
  });
});
