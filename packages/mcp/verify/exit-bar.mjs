/* Exit-bar verification against the REAL built bins (sidecar CLI + MCP stdio
 * server), not in-process mocks. Run after `pnpm -r build`:
 *   node packages/mcp/verify/exit-bar.mjs
 * Exits non-zero on the first failed acceptance condition. */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER_BIN = path.join(ROOT, 'packages/server/dist/cli.js');
const MCP_BIN = path.join(ROOT, 'packages/mcp/dist/index.js');
const STORYBOOK_STATIC = path.join(ROOT, 'examples/demo-storybook/storybook-static');
const ADMIN = 'exitbar-admin';
const PORT = 4811;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-exitbar-'));

let step = 0;
const pass = (m) => console.log(`  ✓ [${++step}] ${m}`);
function assert(cond, m) {
  if (!cond) {
    console.error(`  ✗ FAILED: ${m}`);
    throw new Error(m);
  }
}
const toText = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

const admin = (p, init = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

// A one-component change: rewrite the Button story's rendered marker so build B
// differs from A in exactly one story's fingerprint.
function changedStorybook(dst) {
  fs.cpSync(STORYBOOK_STATIC, dst, { recursive: true });
  const iframe = path.join(dst, 'iframe.html');
  if (fs.existsSync(iframe)) {
    fs.appendFileSync(iframe, '\n<!-- build B: button restyled -->\n');
  }
}

let server;
let mcp;
async function main() {
  server = spawn('node', [SERVER_BIN, 'serve'], {
    env: { ...process.env, GREENROOM_ADMIN_KEY: ADMIN, GREENROOM_DATA_DIR: dataDir, GREENROOM_PORT: String(PORT) },
    stdio: 'inherit',
  });
  await waitFor(`${BASE}/api/health`);
  pass('real sidecar bin booted');

  // ── build A + seed a pinned, screenshotted, changes-requested thread ────────
  const up = spawnSync('node', [SERVER_BIN, 'upload', STORYBOOK_STATIC, '--url', BASE, '--token', ADMIN, '--label', 'design-A'], { encoding: 'utf8' });
  assert(up.status === 0, `upload A failed: ${up.stderr}`);
  const buildA = (await (await admin('/api/builds/latest')).json()).build;
  pass(`build A uploaded (${buildA.storyCount} stories)`);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const att = await (await admin('/api/attachments', { headers: { 'content-type': 'image/png' }, method: 'POST', body: png })).json();
  const STORY = 'components-button--primary';
  await admin('/api/threads', {
    method: 'POST',
    body: JSON.stringify({
      storyId: STORY,
      buildId: buildA.id,
      body: 'Make the Save button green to match the brand.',
      pin: { selector: '.demo-button', x: 480, y: 190, viewportWidth: 1280, viewportHeight: 720 },
      args: { label: 'Save changes', variant: 'primary' },
      screenshotAttachmentId: att.attachmentId,
    }),
  });
  await admin(`/api/stories/${STORY}/status`, { method: 'POST', body: JSON.stringify({ to: 'changes_requested', buildId: buildA.id }) });
  pass('seeded a pinned+screenshotted comment, story set to changes_requested');

  // ── agent path over the REAL MCP stdio bin ──────────────────────────────────
  const agentToken = (await (await admin('/api/tokens', { method: 'POST', body: JSON.stringify({ kind: 'agent', name: 'claude' }) })).json()).token;
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_BIN],
    env: { ...process.env, GREENROOM_URL: BASE, GREENROOM_TOKEN: agentToken },
  });
  mcp = new Client({ name: 'exit-bar', version: '0.0.0' });
  await mcp.connect(transport);
  const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
  assert(
    ['approve_stories', 'get_thread', 'list_feedback', 'list_stories', 'mark_story_addressed', 'mark_thread_addressed', 'reply_to_thread'].every((t) => tools.includes(t)),
    `missing tools: got ${tools.join(', ')}`,
  );
  pass(`MCP bin connected over stdio, 7 tools: ${tools.join(', ')}`);

  const queue = JSON.parse(toText(await mcp.callTool({ name: 'list_stories', arguments: { state: 'changes_requested' } })));
  assert(queue.some((s) => s.storyId === STORY), 'changes_requested queue missing the story');
  pass('list_stories → the agent work queue holds the story');

  const feedback = JSON.parse(toText(await mcp.callTool({ name: 'list_feedback', arguments: {} })));
  assert(feedback[0]?.story?.importPath?.includes('Button.stories'), 'feedback missing CSF importPath');
  assert(feedback[0]?.pin?.selector === '.demo-button', 'feedback missing pin selector');
  const threadId = feedback[0].threadId;
  pass('list_feedback → thread with CSF path + pin selector');

  const thread = await mcp.callTool({ name: 'get_thread', arguments: { threadId } });
  assert(thread.content.some((c) => c.type === 'image' && c.data), 'get_thread returned no image block');
  pass('get_thread → pin screenshot returned as an MCP image block');

  await mcp.callTool({ name: 'reply_to_thread', arguments: { threadId, body: 'Set the button variant to green — pushing a fix.' } });
  const withReply = JSON.parse(toText(await mcp.callTool({ name: 'list_feedback', arguments: {} })));
  assert(withReply[0].messages.some((m) => m.kind === 'agent_note'), 'agent reply not recorded as agent_note');
  pass('reply_to_thread → recorded as an agent note');

  const addressed = toText(await mcp.callTool({ name: 'mark_story_addressed', arguments: { storyId: STORY, note: 'Fix pushed.' } }));
  assert(/addressed/i.test(addressed), `mark_story_addressed unexpected: ${addressed}`);
  pass('mark_story_addressed → story moved to addressed');

  // Agent cannot approve on its own: preview warns, confirm 403s, state unchanged.
  const preview = toText(await mcp.callTool({ name: 'approve_stories', arguments: { storyIds: [STORY] } }));
  assert(/human sign-off/i.test(preview) && /NO stories were approved/i.test(preview), 'preview did not warn / claimed approval');
  const blocked = await mcp.callTool({ name: 'approve_stories', arguments: { storyIds: [STORY], confirm: true } });
  assert(blocked.isError && /delegation/i.test(toText(blocked)), 'confirm without delegation was not blocked');
  let s = (await (await admin(`/api/stories/${STORY}`)).json()).story;
  assert(s.state === 'addressed', `agent approval leaked through — state is ${s.state}`);
  pass('approve_stories → preview warns; confirm without delegation is refused; state unchanged');

  // ── human approves; build B flips reconfirm; agent re-approves under delegation ─
  await admin(`/api/stories/${STORY}/status`, { method: 'POST', body: JSON.stringify({ to: 'approved', buildId: buildA.id }) });
  const otherStories = (await (await admin('/api/stories')).json()).stories.filter((x) => x.storyId !== STORY && x.state === 'in_review');
  for (const other of otherStories) {
    await admin(`/api/stories/${other.storyId}/status`, { method: 'POST', body: JSON.stringify({ to: 'approved', buildId: buildA.id }) });
  }
  pass(`human approved all ${otherStories.length + 1} stories against build A`);

  const bDir = path.join(dataDir, 'storybook-B');
  changedStorybook(bDir);
  const upB = spawnSync('node', [SERVER_BIN, 'upload', bDir, '--url', BASE, '--token', ADMIN, '--label', 'design-B'], { encoding: 'utf8' });
  assert(upB.status === 0, `upload B failed: ${upB.stderr}`);
  const buildB = (await (await admin('/api/builds/latest')).json()).build;
  const reconfirm = (await (await admin('/api/stories?state=needs_reconfirm')).json()).stories;
  assert(reconfirm.length >= 1, 'no stories flipped to needs_reconfirm after build B');
  pass(`build B uploaded → ${reconfirm.length} approvals flipped to needs_reconfirm`);

  // Fingerprints: story changed vs unchanged, and the queue sorts changed-first.
  await admin('/api/fingerprints', { method: 'PUT', body: JSON.stringify({ storyId: STORY, buildId: buildA.id, hash: 'a'.repeat(64) }) });
  await admin('/api/fingerprints', { method: 'PUT', body: JSON.stringify({ storyId: STORY, buildId: buildB.id, hash: 'b'.repeat(64) }) });
  const other = reconfirm.find((x) => x.storyId !== STORY);
  if (other) {
    await admin('/api/fingerprints', { method: 'PUT', body: JSON.stringify({ storyId: other.storyId, buildId: buildA.id, hash: 'c'.repeat(64) }) });
    await admin('/api/fingerprints', { method: 'PUT', body: JSON.stringify({ storyId: other.storyId, buildId: buildB.id, hash: 'c'.repeat(64) }) });
  }
  const q = (await (await admin(`/api/reconfirm-queue?buildId=${buildB.id}`)).json()).items;
  const changed = q.find((i) => i.story.storyId === STORY);
  assert(changed?.verdict === 'changed', `changed story verdict was ${changed?.verdict}`);
  if (other) assert(q[0].verdict === 'changed', 'queue not sorted changed-first');
  pass('fingerprint sweep → changed story flagged "changed", queue sorted changed-first');

  // A stale approval (pinned to build A, now superseded) must be refused.
  const stale = await admin(`/api/stories/${STORY}/status`, { method: 'POST', body: JSON.stringify({ to: 'approved', buildId: buildA.id }) });
  assert(stale.status === 409, `stale-build approval was not refused (status ${stale.status})`);
  pass('stale-build approval refused (409) — no forged green on changed markup');

  // Delegated agent approval now works and is audit-labeled.
  await admin('/api/delegations', { method: 'POST', body: JSON.stringify({ authorizationNote: 'Client email 2026-08-12: approve remaining screens for launch.' }) });
  const delegated = await mcp.callTool({ name: 'approve_stories', arguments: { storyIds: [STORY], confirm: true } });
  assert(!delegated.isError && /approved/i.test(toText(delegated)), `delegated approval failed: ${toText(delegated)}`);
  const audit = await (await admin('/api/audit/export')).json();
  const delegatedEvent = audit.statusEvents.find((e) => e.approvalMode === 'delegated' && e.principal.kind === 'agent');
  assert(delegatedEvent && delegatedEvent.delegationId, 'no delegated agent approval in the audit trail');
  const directEvents = audit.statusEvents.filter((e) => e.approvalMode === 'direct');
  assert(directEvents.length >= 1, 'no direct human approvals in the audit trail');
  pass(`audit export → ${directEvents.length} direct human + 1 delegated agent approval, all labeled`);

  console.log('\nEXIT BAR: all acceptance conditions met.');
}

main()
  .then(() => cleanup(0))
  .catch((e) => {
    console.error('\nEXIT BAR FAILED:', e.message);
    cleanup(1);
  });

function cleanup(code) {
  try { mcp?.close?.(); } catch {}
  try { server?.kill(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
