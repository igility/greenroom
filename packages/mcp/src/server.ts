import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AGENT_APPROVAL_WARNING } from '@igility/greenroom-shared';
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
  /**
   * The surface the reviewer was looking at when they said it, when it differs from
   * `story` — a contact sheet showing this component among many others.
   *
   * This changes how a remark should be read. "Make this smaller" said while looking
   * at one component is about the component; said while looking at a grid of thirty,
   * it may be about how it sits among its neighbours. Never edit the surface's own
   * file in response — a contact sheet is a review instrument, not the product.
   */
  seenOnStoryId: item.thread.seenOnStoryId,
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
        "story's CSF importPath so you can open the source file the story comes from, the " +
        'component it belongs to, plus the pin location, story args at comment time, whether ' +
        'a screenshot exists, and the full message history. Defaults to state=open (the ' +
        'feedback still awaiting work).\n\n' +
        'A comment is filed against the component the reviewer was pointing at, which is ' +
        'not always the story they had open — see seenOnStoryId. Fix the component named in ' +
        'story.importPath.',
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
        'signal that the work is done. Addressed is NOT resolved: the thread still counts ' +
        'as unresolved and still blocks approval of the variant it sits on until a human ' +
        'accepts your fix. That is deliberate — do not read a still-blocked variant as your ' +
        'change having failed, and never try to route around it.',
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
      title: 'Mark a component addressed',
      description:
        'Move a component whose state is changes_requested to addressed, after you have ' +
        'pushed fixes for it. This puts it back in front of the human reviewers for sign-off. ' +
        'State moves at the COMPONENT, not the variant: pass any story id belonging to the ' +
        'component (the CSF file) and every variant in that file moves with it. Reviewers ' +
        'sign off on components, so a single variant cannot be moved on its own.',
      inputSchema: {
        storyId: z
          .string()
          .describe(
            'Any story id belonging to the component, e.g. components-button--primary. ' +
              'The whole component moves.',
          ),
        note: z.string().optional().describe('What was fixed; lands in the audit trail.'),
      },
    },
    async ({ storyId, note }) => {
      try {
        const { story } = await client.setStoryStatus(storyId, { to: 'addressed', note });
        return textResult(
          `Component "${story.componentTitle || story.title}" is now ${story.state} ` +
            `(every variant in ${story.importPath}).`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_stories',
    {
      title: 'List components and review states',
      description:
        'List what is under review, one row per story variant, carrying its component, its ' +
        'state, its thread counts, and whether its render has moved since a human approved ' +
        'it. state=changes_requested is your work queue. Rows sharing an importPath are one ' +
        'component and always share a state.\n\n' +
        'changedSinceApproval=true means a human approved it and the render has changed ' +
        'since — often because of something you did. It is a flag for THEM to re-look, not ' +
        'a task for you: the approval still stands and nothing is asking you to act. Report ' +
        'it, do not try to clear it.\n\n' +
        'unresolvedThreads is what blocks approval of that variant, and counts threads you ' +
        'have marked addressed but no human has accepted yet.\n\n' +
        'Contact sheets are excluded unless you ask for them. A sheet is a review instrument ' +
        'that lives in the repo like any other story; editing one changes what reviewers look ' +
        'THROUGH, not what they are looking AT. Never edit a sheet to satisfy feedback.',
      inputSchema: {
        state: z
          .enum(['in_review', 'changes_requested', 'addressed', 'approved'])
          .optional()
          .describe('Filter by review state.'),
        changedSinceApproval: z
          .boolean()
          .optional()
          .describe('Only approved items whose render has moved since approval.'),
        includeSheets: z
          .boolean()
          .optional()
          .describe('Include contact sheets. Defaults false; you almost never want them.'),
      },
    },
    async ({ state, changedSinceApproval, includeSheets }) => {
      try {
        const { stories } = await client.listStories({
          state,
          ...(includeSheets ? {} : { kind: 'story' as const }),
        });
        const rows = changedSinceApproval ? stories.filter((s) => s.changedSinceApproval) : stories;
        return jsonResult(rows);
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
        'Approvals pin to the latest build and are audit-labeled "delegated".\n\n' +
        'Approval moves the whole COMPONENT: each id you pass approves every variant in that ' +
        'CSF file, except variants carrying an unresolved comment, which are left alone. If ' +
        'no variant is eligible the server refuses the component outright (OPEN_THREADS). ' +
        'A delegation to approve "the button" therefore covers more than the one id names — ' +
        'check the preview before confirming.',
      inputSchema: {
        storyIds: z
          .array(z.string())
          .min(1)
          .describe('One story id per component to approve; the whole component moves.'),
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
          // Show the component, not the id. Approval moves every variant in the CSF file,
          // so a preview listing only the id named would understate what confirming does —
          // and the whole point of the preview is that a human can check the delegation
          // actually covers it.
          const preview = storyIds
            .map((sid) => {
              const s = byId.get(sid);
              if (!s) return `  ${sid}: NOT FOUND on the server`;
              const siblings = stories.filter((m) => m.importPath === s.importPath);
              const blocked = siblings.filter((m) => m.unresolvedThreads > 0);
              const eligible = siblings.length - blocked.length;
              const label = s.componentTitle || s.title;
              const lines = [
                `  ${sid}`,
                `    component "${label}" (${s.importPath}), currently ${s.state}`,
                eligible === 0
                  ? `    WOULD BE REFUSED: all ${siblings.length} variants have unresolved comments`
                  : `    would approve ${eligible} of ${siblings.length} variants`,
              ];
              if (blocked.length && eligible > 0) {
                lines.push(
                  `    left alone (unresolved comments): ${blocked.map((m) => m.storyId).join(', ')}`,
                );
              }
              return lines.join('\n');
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
