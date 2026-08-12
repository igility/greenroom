import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AGENT_APPROVAL_WARNING } from '@greenroom/shared';
import { z } from 'zod';
import type { FeedbackItem, SidecarClient } from './client.js';

const errorResult = (err: unknown): CallToolResult => ({
  content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

const textResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });

const jsonResult = (value: unknown): CallToolResult =>
  textResult(JSON.stringify(value, null, 2));

/** Compact view of a feedback item for agent consumption. */
const feedbackView = (item: FeedbackItem) => ({
  threadId: item.thread.id,
  threadState: item.thread.state,
  buildId: item.thread.buildId,
  story: item.story,
  pin: item.thread.pin,
  args: item.thread.args,
  hasScreenshot: item.thread.screenshotAttachmentId !== null,
  createdBy: item.thread.createdBy,
  createdAt: item.thread.createdAt,
  messages: item.messages.map((m) => ({
    author: m.author,
    kind: m.kind,
    body: m.body,
    createdAt: m.createdAt,
  })),
});

export function buildServer(client: SidecarClient): McpServer {
  const server = new McpServer({ name: 'greenroom', version: '0.0.0' });

  server.registerTool(
    'list_feedback',
    {
      title: 'List review feedback',
      description:
        'List human review feedback threads on Storybook stories. Each item carries the ' +
        "story's CSF importPath so you can open the source file the story comes from, plus " +
        'the pin location, story args at comment time, whether a screenshot exists, and the ' +
        'full message history. Defaults to state=open (the feedback still awaiting work).',
      inputSchema: {
        state: z
          .enum(['open', 'addressed', 'resolved', 'all'])
          .optional()
          .describe('Thread state filter; defaults to open.'),
        storyId: z.string().optional().describe('Limit to one story.'),
      },
    },
    async ({ state, storyId }) => {
      try {
        const effective = state ?? 'open';
        const { feedback } = await client.listFeedback({
          state: effective === 'all' ? undefined : effective,
          storyId,
        });
        return jsonResult(feedback.map(feedbackView));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Get a feedback thread',
      description:
        'Fetch one feedback thread in full: story context (including the CSF importPath), ' +
        'pin, args, and every message. When the reviewer pinned a screenshot, it is returned ' +
        'as an image so you can see exactly what they were looking at.',
      inputSchema: {
        threadId: z.string().describe('Thread id from list_feedback.'),
      },
    },
    async ({ threadId }) => {
      try {
        const { feedback } = await client.getThread(threadId);
        const result = jsonResult(feedbackView(feedback));
        if (feedback.thread.screenshotAttachmentId) {
          const shot = await client.screenshot(feedback.thread.screenshotAttachmentId);
          result.content.push({
            type: 'image',
            data: Buffer.from(shot.bytes).toString('base64'),
            mimeType: shot.mimeType,
          });
        }
        return result;
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'reply_to_thread',
    {
      title: 'Reply to a feedback thread',
      description:
        'Post a reply on a feedback thread. Your reply is recorded as an agent note, visible ' +
        'to the human reviewers. Use it to explain what you changed or to ask for clarification.',
      inputSchema: {
        threadId: z.string().describe('Thread id from list_feedback.'),
        body: z.string().min(1).describe('The reply text.'),
      },
    },
    async ({ threadId, body }) => {
      try {
        const { message } = await client.postMessage(threadId, body);
        return textResult(`Reply posted on thread ${threadId} (message ${message.id}).`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'mark_thread_addressed',
    {
      title: 'Mark a feedback thread addressed',
      description:
        'Mark one feedback thread as addressed after you have done the work it asked for. ' +
        'Optionally post a note first explaining the fix. Humans resolve threads; you only ' +
        'signal that the work is done.',
      inputSchema: {
        threadId: z.string().describe('Thread id from list_feedback.'),
        note: z.string().optional().describe('Optional reply describing the fix, posted first.'),
      },
    },
    async ({ threadId, note }) => {
      try {
        if (note) await client.postMessage(threadId, note);
        const { feedback } = await client.setThreadState(threadId, 'addressed');
        return textResult(
          `Thread ${threadId} marked addressed (story ${feedback.story.storyId}).`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'mark_story_addressed',
    {
      title: 'Mark a story addressed',
      description:
        'Move a story whose state is changes_requested to addressed, after you have pushed ' +
        'fixes for it. This puts the story back in front of the human reviewers for sign-off.',
      inputSchema: {
        storyId: z.string().describe('Storybook story id, e.g. components-button--primary.'),
        note: z.string().optional().describe('What was fixed; lands in the audit trail.'),
      },
    },
    async ({ storyId, note }) => {
      try {
        const { story } = await client.setStoryStatus(storyId, { to: 'addressed', note });
        return textResult(`Story ${storyId} is now ${story.state}.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_stories',
    {
      title: 'List stories and review states',
      description:
        'List every story under review with its state and open-thread count. ' +
        'state=changes_requested is your work queue: stories a human reviewed and asked for ' +
        'changes on. needs_reconfirm belongs to human reviewers, not you.',
      inputSchema: {
        state: z
          .enum(['in_review', 'changes_requested', 'addressed', 'approved', 'needs_reconfirm'])
          .optional()
          .describe('Filter by story state.'),
      },
    },
    async ({ state }) => {
      try {
        const { stories } = await client.listStories({ state });
        return jsonResult(stories);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'approve_stories',
    {
      title: 'Approve stories (delegated only)',
      description:
        'DANGER: approval is a HUMAN sign-off. This tool only works when an admin has ' +
        'recorded a written human authorization (a delegation) on the Greenroom server; ' +
        'without one the server refuses and the attempt is audit-logged. Never call this on ' +
        'your own initiative. First call without confirm to get a preview of what would be ' +
        'approved; call again with confirm:true only if a recorded delegation covers it. ' +
        'Approvals pin to the latest build and are audit-labeled "delegated".',
      inputSchema: {
        storyIds: z.array(z.string()).min(1).describe('Story ids to approve.'),
        confirm: z
          .boolean()
          .optional()
          .describe('Must be true to actually approve; omit to preview.'),
      },
    },
    async ({ storyIds, confirm }) => {
      try {
        const [{ stories }, { build }] = await Promise.all([
          client.listStories(),
          client.latestBuild(),
        ]);
        const byId = new Map(stories.map((s) => [s.storyId, s]));

        if (!confirm) {
          const preview = storyIds
            .map((sid) => {
              const s = byId.get(sid);
              return s ? `  ${sid}: currently ${s.state}` : `  ${sid}: NOT FOUND on the server`;
            })
            .join('\n');
          const buildLine = build
            ? `${build.id} ("${build.label}")`
            : 'NONE — no builds uploaded, approval will fail';
          return textResult(
            `${AGENT_APPROVAL_WARNING}\n\n` +
              `NO stories were approved. Preview of what confirm:true would do:\n${preview}\n` +
              `Approval would pin to the latest build: ${buildLine}.\n\n` +
              'Call approve_stories again with confirm:true ONLY if a recorded human ' +
              'delegation covers approving these stories. If you are not certain one exists, ' +
              'stop and ask the human.',
          );
        }

        const results: string[] = [];
        let failures = 0;
        for (const sid of storyIds) {
          try {
            const { story } = await client.setStoryStatus(sid, {
              to: 'approved',
              ...(build ? { buildId: build.id } : {}),
            });
            results.push(`${sid}: approved (pinned to build ${story.anchorBuildId}).`);
          } catch (err) {
            failures++;
            // 403 carries the server's warning text — report it verbatim.
            results.push(`${sid}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const out = textResult(results.join('\n'));
        if (failures === storyIds.length) out.isError = true;
        return out;
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
