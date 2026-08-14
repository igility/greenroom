import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AGENT_APPROVAL_WARNING, SHEET_TAG, type Principal } from '@igility/greenroom-shared';
// @igility/greenroom-server exports only its built CLI; tests reach into src directly.
import { createApp } from '../../server/src/app.js';
import { openMemoryDb } from '../../server/src/db.js';
import { Store } from '../../server/src/store.js';
import type { Config } from '../../server/src/config.js';
import { SidecarClient } from '../src/client.js';
import { buildServer } from '../src/server.js';

const enc = (s: string) => new TextEncoder().encode(s);

const storybookZip = (marker = 'v1') =>
  zipSync({
    'index.json': enc(
      JSON.stringify({
        v: 5,
        entries: {
          'components-button--primary': {
            type: 'story',
            title: 'Components/Button',
            name: 'Primary',
            importPath: './src/Button.stories.tsx',
          },
          // A second variant of the SAME component. Approval and state moves run at the
          // component, so a fixture with one variant each cannot show the difference
          // between moving a variant and moving a component.
          'components-button--loading': {
            type: 'story',
            title: 'Components/Button',
            name: 'Loading',
            importPath: './src/Button.stories.tsx',
          },
          'components-badge--success': {
            type: 'story',
            title: 'Components/Badge',
            name: 'Success',
            importPath: './src/Badge.stories.tsx',
          },
          // The agent's queue must never contain this. It is a review instrument: an
          // agent that edits it changes what reviewers look through.
          'review-allcomponents--sheet': {
            type: 'story',
            title: 'Review/AllComponents',
            name: 'Sheet',
            importPath: './src/AllComponents.stories.tsx',
            tags: [SHEET_TAG],
          },
        },
      }),
    ),
    // The marker varies the bytes. Ingest dedupes on the manifest hash, so a second
    // upload of identical content is the SAME build, not a new one.
    'iframe.html': enc(`<html><body>fixture ${marker}</body></html>`),
  });

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const ADMIN: Principal = { kind: 'admin', id: 'env-admin', name: 'Admin' };
const REVIEWER: Principal = { kind: 'reviewer', id: 'rev-1', name: 'Jordan Client' };

const BUTTON = 'components-button--primary';
const BADGE = 'components-badge--success';
const BUTTON_LOADING = 'components-button--loading';
const SHEET = 'review-allcomponents--sheet';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-mcp-test-'));
const store = new Store(openMemoryDb(), dataDir);
let httpServer: ServerType;
let buildId: string;
let threadId: string;
const mcp = new Client({ name: 'test-agent', version: '0.0.0' });

type Block = { type: string; text?: string; data?: string; mimeType?: string };
const callTool = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await mcp.callTool({ name, arguments: args });
  return { content: result.content as Block[], isError: result.isError === true };
};
const textOf = (blocks: Block[]) =>
  blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

beforeAll(async () => {
  const config: Config = {
    dataDir,
    port: 0,
    publicUrl: 'http://greenroom.test',
    adminKey: 'test-admin-key',
    adminKeyGenerated: false,
    shellDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server/shell'),
  };
  const app = createApp(store, config);
  const port = await new Promise<number>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });

  const ingest = store.ingestBuildZip(storybookZip(), { label: 'design-v1' }, ADMIN);
  buildId = ingest.build.id;

  const attachmentId = store.saveAttachment(new Uint8Array(PNG_1PX), 'image/png');
  const feedback = store.createThread(
    {
      storyId: BUTTON,
      buildId,
      body: 'The label wraps on small screens — keep it on one line.',
      pin: { selector: 'button.demo', x: 0.5, y: 0.4, viewportWidth: 1280, viewportHeight: 720 },
      args: { label: 'Save changes' },
      screenshotAttachmentId: attachmentId,
    },
    ADMIN,
  );
  threadId = feedback.thread.id;

  const agent = store.createToken('agent', 'Claude');
  const sidecar = new SidecarClient({ url: `http://127.0.0.1:${port}`, token: agent.token });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildServer(sidecar).connect(serverTransport);
  await mcp.connect(clientTransport);
});

afterAll(async () => {
  await mcp.close();
  httpServer?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('greenroom mcp server', () => {
  it('list_feedback returns the thread with importPath and pin', async () => {
    const { content, isError } = await callTool('list_feedback');
    expect(isError).toBe(false);
    const items = JSON.parse(textOf(content));
    expect(items).toHaveLength(1);
    expect(items[0].threadId).toBe(threadId);
    expect(items[0].story.importPath).toBe('./src/Button.stories.tsx');
    // The component the comment is filed against, not the variant. Both the addon and
    // this server declared the field before the payload carried it, so both read
    // undefined and fell back to the variant name without anything failing.
    expect(items[0].story.componentTitle).toBe('Components/Button');
    expect(items[0].pin.selector).toBe('button.demo');
    expect(items[0].hasScreenshot).toBe(true);
  });

  it('get_thread returns an image content block for the pin screenshot', async () => {
    const { content, isError } = await callTool('get_thread', { threadId });
    expect(isError).toBe(false);
    const image = content.find((b) => b.type === 'image');
    expect(image).toBeTruthy();
    expect(image!.mimeType).toBe('image/png');
    expect(Buffer.from(image!.data!, 'base64').equals(PNG_1PX)).toBe(true);
  });

  it('reply_to_thread lands as an agent_note', async () => {
    const { isError } = await callTool('reply_to_thread', {
      threadId,
      body: 'Set white-space: nowrap on the label. Pushing a fix.',
    });
    expect(isError).toBe(false);
    const messages = store.getFeedbackItem(threadId).messages;
    const last = messages[messages.length - 1]!;
    expect(last.kind).toBe('agent_note');
    expect(last.author.kind).toBe('agent');
  });

  it('mark_thread_addressed posts the note then flips the thread state', async () => {
    const { isError } = await callTool('mark_thread_addressed', {
      threadId,
      note: 'Fixed in the latest push.',
    });
    expect(isError).toBe(false);
    expect(store.getFeedbackItem(threadId).thread.state).toBe('addressed');
  });

  it('mark_story_addressed moves a changes_requested story to addressed', async () => {
    store.setStoryState(BADGE, 'changes_requested', REVIEWER, { buildId });
    const { content, isError } = await callTool('mark_story_addressed', {
      storyId: BADGE,
      note: 'Contrast fix pushed.',
    });
    expect(isError).toBe(false);
    expect(textOf(content)).toContain('addressed');
    expect(store.getStory(BADGE).state).toBe('addressed');
  });

  it('approve_stories without confirm warns and changes nothing', async () => {
    const { content, isError } = await callTool('approve_stories', { storyIds: [BADGE] });
    expect(isError).toBe(false);
    const text = textOf(content);
    expect(text).toContain(AGENT_APPROVAL_WARNING);
    expect(text).toContain(BADGE);
    expect(text).toContain(buildId);
    expect(store.getStory(BADGE).state).toBe('addressed');
  });

  it('approve_stories with confirm but no delegation is refused with the warning', async () => {
    const { content, isError } = await callTool('approve_stories', {
      storyIds: [BADGE],
      confirm: true,
    });
    expect(isError).toBe(true);
    expect(textOf(content)).toContain(AGENT_APPROVAL_WARNING);
    expect(store.getStory(BADGE).state).toBe('addressed');
  });

  it('approve_stories with confirm approves under a recorded delegation, audit-labeled', async () => {
    store.createDelegation('Client email 2026-08-12: approve remaining screens.', ADMIN);
    const { content, isError } = await callTool('approve_stories', {
      storyIds: [BADGE],
      confirm: true,
    });
    expect(isError).toBe(false);
    expect(textOf(content)).toContain('approved');
    const story = store.getStory(BADGE);
    expect(story.state).toBe('approved');
    expect(story.anchorBuildId).toBe(buildId);
    const delegated = store
      .listEvents(BADGE)
      .find((e) => e.to === 'approved' && e.approvalMode === 'delegated');
    expect(delegated).toBeTruthy();
    expect(delegated!.principal.kind).toBe('agent');
    expect(delegated!.delegationId).toBeTruthy();
  });

  // ── the component model, as the agent sees it ─────────────────────────────

  it('list_stories keeps contact sheets out of the agent queue', async () => {
    const { content, isError } = await callTool('list_stories');
    expect(isError).toBe(false);
    const ids = (JSON.parse(textOf(content)) as { storyId: string }[]).map((s) => s.storyId);
    expect(ids).toContain(BUTTON);
    // The whole point. A sheet in this list is an invitation to edit the review
    // instrument in response to feedback about the product.
    expect(ids).not.toContain(SHEET);
  });

  it('list_stories returns a sheet only when explicitly asked for one', async () => {
    const { content } = await callTool('list_stories', { includeSheets: true });
    const ids = (JSON.parse(textOf(content)) as { storyId: string }[]).map((s) => s.storyId);
    expect(ids).toContain(SHEET);
  });

  it('list_stories carries the component and the count that blocks approval', async () => {
    const { content } = await callTool('list_stories');
    const rows = JSON.parse(textOf(content)) as {
      storyId: string;
      componentTitle: string;
      importPath: string;
      unresolvedThreads: number;
      openThreads: number;
    }[];
    const primary = rows.find((s) => s.storyId === BUTTON)!;
    const loading = rows.find((s) => s.storyId === BUTTON_LOADING)!;
    expect(primary.componentTitle).toBe('Components/Button');
    expect(loading.importPath).toBe(primary.importPath);
    // The thread above was marked addressed, never resolved. Addressed still blocks:
    // an agent's own claim that it fixed something is not a human accepting the fix.
    expect(primary.openThreads).toBe(0);
    expect(primary.unresolvedThreads).toBe(1);
    // And the block is confined to the variant the comment sits on.
    expect(loading.unresolvedThreads).toBe(0);
  });

  it('the approval preview names the component and the variants it would leave alone', async () => {
    const { content, isError } = await callTool('approve_stories', { storyIds: [BUTTON] });
    expect(isError).toBe(false);
    const text = textOf(content);
    expect(text).toContain('Components/Button');
    // Passing one id would move two variants; the preview has to say so, or a human
    // checking it against a delegation is checking the wrong thing.
    expect(text).toContain('would approve 1 of 2 variants');
    expect(text).toContain(`left alone (unresolved comments): ${BUTTON}`);
    expect(store.getStory(BUTTON).state).not.toBe('approved');
    expect(store.getStory(BUTTON_LOADING).state).not.toBe('approved');
  });

  it('list_stories can single out an approval whose render has moved since', async () => {
    // BADGE was approved above against the first build. Record the render the reviewer
    // signed off on, then ship a build where it renders differently.
    store.putRenderReport(BADGE, buildId, { hash: 'hash-as-approved' });
    const second = store.ingestBuildZip(storybookZip('v2'), { label: 'design-v2' }, ADMIN);
    expect(second.created).toBe(true);
    store.putRenderReport(BADGE, second.build.id, { hash: 'hash-after-restyle' });

    const { content, isError } = await callTool('list_stories', { changedSinceApproval: true });
    expect(isError).toBe(false);
    const rows = JSON.parse(textOf(content)) as { storyId: string }[];
    expect(rows.map((s) => s.storyId)).toEqual([BADGE]);

    // The flag reports; it does not withdraw. The approval stands and its anchor still
    // names the build a person actually looked at.
    const badge = store.getStory(BADGE);
    expect(badge.state).toBe('approved');
    expect(badge.anchorBuildId).toBe(buildId);
  });

  it('an unreviewed story is never flagged as changed, however much it moves', async () => {
    // No sign-off exists for a change to have outrun, so there is nothing to report.
    const latest = (await store.listBuilds())[0]!;
    store.putRenderReport(BUTTON_LOADING, latest.id, { hash: 'moved-a-lot' });
    const { content } = await callTool('list_stories', { changedSinceApproval: true });
    const ids = (JSON.parse(textOf(content)) as { storyId: string }[]).map((s) => s.storyId);
    expect(store.getStory(BUTTON_LOADING).state).not.toBe('approved');
    expect(ids).not.toContain(BUTTON_LOADING);
  });
});
