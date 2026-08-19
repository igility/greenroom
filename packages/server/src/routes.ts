import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { StoryKind } from '@igility/greenroom-shared';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { HttpError, withStaleBuildNotice } from './util.js';
import { requirePrincipal, principalOf, SESSION_COOKIE, type AppEnv } from './auth.js';
import { createLinkRequestHandler } from './link-request.js';
import { createMailer, type Mailer } from './mail.js';

const STORY_STATES = ['in_review', 'changes_requested', 'addressed', 'approved'] as const;
const THREAD_STATES = ['open', 'addressed', 'resolved'] as const;

const pinSchema = z.object({
  selector: z.string(),
  x: z.number(),
  y: z.number(),
  viewportWidth: z.number(),
  viewportHeight: z.number(),
  /** Storybook's named viewport, when the reviewer had one selected. Optional because
   *  the reviewer shell has no viewport control and a plain Storybook may have no
   *  preset chosen — the width is recorded either way. */
  viewportLabel: z.string().max(64).nullish(),
});

export const MIME: Record<string, string> = {
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
  json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', map: 'application/json',
  txt: 'text/plain',
};

async function body<T extends z.ZodType>(c: { req: { text: () => Promise<string> } }, schema: T): Promise<z.output<T>> {
  const text = await c.req.text();
  let raw: unknown;
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Request body must be JSON.');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `Invalid request: ${parsed.error.message}`);
  return parsed.data;
}

// Upload guardrails — a single-process sidecar must not be OOM'd or have its
// disk filled by an oversized or zip-bomb upload. Overridable via env.
const MAX_UPLOAD_BYTES = Number(process.env.GREENROOM_MAX_UPLOAD_BYTES ?? 250 * 1024 * 1024);

export function registerRoutes(
  app: Hono<AppEnv>,
  store: Store,
  config: Config,
  mailer: Mailer = createMailer(config),
) {
  const requestReviewLink = createLinkRequestHandler(store, config, mailer);

  /*
   * Ask for a review link. Unauthenticated by necessity — the caller has no session,
   * which is the entire situation this exists for.
   *
   * The response never varies. Same status, same body, whether the address belongs to a
   * reviewer, belongs to nobody, or was rate-limited. Anything else makes this a
   * directory of who is reviewing an unreleased product. See `link-request.ts`.
   */
  app.post('/api/review-links/request', async (c) => {
    const input = await body(c, z.object({ email: z.string().min(3).max(320) }));
    const callerKey =
      c.req.header('cf-connecting-ip') ??
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      'unknown';
    // Awaited so a send failure is handled — but its outcome is deliberately discarded.
    await requestReviewLink(input.email, callerKey);
    return c.json({
      ok: true,
      message: 'If that address is on this review, a link is on its way.',
    });
  });

  // ── builds ────────────────────────────────────────────────────────────────
  app.post('/api/builds', requirePrincipal('admin', 'agent'), async (c) => {
    const label = c.req.query('label') ?? new Date().toISOString().slice(0, 16);
    const gitSha = c.req.query('gitSha') ?? undefined;
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, `Upload exceeds the ${MAX_UPLOAD_BYTES}-byte limit.`);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.byteLength) throw new HttpError(400, 'Empty upload — send a zip of storybook-static.');
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, `Upload exceeds the ${MAX_UPLOAD_BYTES}-byte limit.`);
    }
    // Opt-in, and named for what it permits rather than for silencing the check. The
    // list forms are the ones worth using: they assert WHAT is changing, and an assertion
    // that does not match the artifact fails, where a bare yes is answered yes every time.
    const list = (q: string) =>
      (c.req.query(q) ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    const allowStoryChanges = ['1', 'true', 'yes'].includes(
      (c.req.query('allowStoryChanges') ?? '').toLowerCase(),
    );
    const result = store.ingestBuildZip(
      bytes,
      {
        label,
        gitSha,
        allowStoryChanges,
        allowAdded: list('allowAdded'),
        allowRemoved: list('allowRemoved'),
      },
      principalOf(c),
    );
    return c.json(result, result.created ? 201 : 200);
  });

  /*
   * Named audience scopes — the vocabulary an upload claim is written in.
   *
   * Admin-only to write, because a scope is what an override is checked AGAINST: anyone
   * who can redefine `batch2` can make any build satisfy a claim of `batch2`, which would
   * turn the gate back into the confirmation it replaced.
   */
  app.get('/api/scopes', requirePrincipal(), (c) => c.json({ scopes: store.listScopes() }));
  app.put('/api/scopes/:name', requirePrincipal('admin'), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { groups?: unknown };
    if (!Array.isArray(body.groups)) throw new HttpError(400, 'Send { groups: string[] }.');
    return c.json({
      scope: store.setScope(c.req.param('name'), body.groups.map(String), principalOf(c)),
    });
  });
  app.delete('/api/scopes/:name', requirePrincipal('admin'), (c) =>
    c.json({ deleted: store.deleteScope(c.req.param('name')) }),
  );

  app.get('/api/builds', requirePrincipal(), (c) => c.json({ builds: store.listBuilds() }));
  app.get('/api/builds/latest', requirePrincipal(), (c) => c.json({ build: store.latestBuild() }));
  app.get('/api/builds/:id', requirePrincipal(), (c) => c.json({ build: store.getBuild(c.req.param('id')) }));
  app.get('/api/builds/:id/fingerprints', requirePrincipal(), (c) =>
    c.json({ count: store.fingerprintCount(c.req.param('id')) }),
  );

  app.get('/builds/:id/*', requirePrincipal(), (c) => {
    const rel = c.req.path.replace(`/builds/${c.req.param('id')}/`, '');
    const filePath = store.buildFilePath(c.req.param('id'), decodeURIComponent(rel));
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new HttpError(404, 'Not found.');
    }
    const ext = filePath.split('.').pop() ?? '';
    c.header('content-type', MIME[ext] ?? 'application/octet-stream');
    const bytes = fs.readFileSync(filePath);

    /*
     * Tell a reviewer when they are looking at a build that has been superseded.
     *
     * A reviewer arrives through a magic link, which redirects to whatever build was
     * latest at that moment — and from then on the build id is in the URL. Every click
     * after that stays inside that build, a bookmark pins it forever, and refreshing
     * cannot help, because the id is the address.
     *
     * 🔴 That fails in the worst direction. The reviewer sees a coherent, working
     * Storybook and has no way to know it is stale, so they review superseded work
     * believing it is current — and report problems that were fixed builds ago. It has
     * already happened once, which is why this exists.
     *
     * The pinning itself is correct and stays: an approval binds to a specific build, and
     * that is the whole point of the tool. What was missing was only the signal.
     */
    if (rel === 'index.html') {
      const latest = store.latestBuild();
      if (latest && latest.id !== c.req.param('id')) {
        return c.body(new Uint8Array(withStaleBuildNotice(bytes, latest.id, c.req.query('path'))));
      }
    }
    return c.body(new Uint8Array(bytes));
  });

  // ── stories + status ──────────────────────────────────────────────────────
  app.get('/api/stories', requirePrincipal(), (c) => {
    const state = c.req.query('state') as (typeof STORY_STATES)[number] | undefined;
    if (state && !STORY_STATES.includes(state)) throw new HttpError(400, `Unknown state ${state}.`);
    // `kind` exists for the agent. A contact sheet is a review instrument that lives in
    // the client's repo like any other story, so an agent handed the unfiltered list can
    // read a comment routed to a sheet and go edit the sheet — changing what reviewers
    // look through rather than what they are looking at. The reviewer shell wants sheets
    // and omits this; nothing else should.
    const kind = c.req.query('kind') as StoryKind | undefined;
    if (kind && kind !== 'story' && kind !== 'sheet') {
      throw new HttpError(400, `Unknown kind ${kind}.`);
    }
    return c.json({ stories: store.listStories({ state, kind }) });
  });

  app.get('/api/stories/:storyId', requirePrincipal(), (c) => {
    const story = store.getStory(c.req.param('storyId'));
    // Approved-and-since-changed is the panel's most load-bearing distinction now that
    // a change no longer withdraws the approval, so it travels with the story itself.
    return c.json({ story: { ...story, changedSinceApproval: store.changedSinceApproval(story) } });
  });

  app.post('/api/stories/:storyId/status', requirePrincipal(), async (c) => {
    const input = await body(
      c,
      z.object({
        to: z.enum(STORY_STATES),
        buildId: z.string().optional(),
        note: z.string().optional(),
      }),
    );
    const story = store.setStoryState(c.req.param('storyId'), input.to, principalOf(c), input);
    return c.json({ story });
  });

  // What else moved in this build. Offered only after a component has actually been
  // re-confirmed, so the reviewer is agreeing on the strength of something they just
  // looked at rather than being handed a bulk-approve button on arrival.
  app.get('/api/stories/:storyId/also-changed', requirePrincipal(), (c) => {
    const storyId = c.req.param('storyId');
    return c.json({ stories: store.alsoChanged(storyId) });
  });

  app.post('/api/stories/batch-approve', requirePrincipal(), async (c) => {
    const input = await body(
      c,
      z.object({
        storyIds: z.array(z.string()).min(1),
        /** The component the reviewer actually opened; named in every audit row. */
        becauseOf: z.string(),
        buildId: z.string(),
      }),
    );
    const result = store.batchApprove(input.storyIds, principalOf(c), {
      buildId: input.buildId,
      becauseOf: input.becauseOf,
    });
    return c.json(result);
  });

  // ── threads + feedback ────────────────────────────────────────────────────
  app.post('/api/threads', requirePrincipal(), async (c) => {
    const input = await body(
      c,
      z.object({
        storyId: z.string(),
        /** The tile clicked, when the surface declared regions. */
        regionStoryId: z.string().nullish(),
        buildId: z.string(),
        body: z.string().min(1),
        pin: pinSchema.optional(),
        args: z.record(z.string(), z.unknown()).optional(),
        screenshotAttachmentId: z.string().optional(),
      }),
    );
    // `viewportLabel` is optional over the wire — an older panel, the shell, or a
    // reviewer with no preset selected all omit it — but a Pin either carries a label or
    // carries null. Normalise once here rather than letting `undefined` travel inward.
    const pin = input.pin ? { ...input.pin, viewportLabel: input.pin.viewportLabel ?? null } : undefined;
    return c.json({ feedback: store.createThread({ ...input, pin }, principalOf(c)) }, 201);
  });

  app.get('/api/feedback', requirePrincipal(), (c) => {
    const threadState = c.req.query('state') as (typeof THREAD_STATES)[number] | undefined;
    if (threadState && !THREAD_STATES.includes(threadState)) {
      throw new HttpError(400, `Unknown thread state ${threadState}.`);
    }
    return c.json({
      feedback: store.listFeedback({ storyId: c.req.query('storyId'), threadState }),
    });
  });

  app.get('/api/threads/:id', requirePrincipal(), (c) =>
    c.json({ feedback: store.getFeedbackItem(c.req.param('id')) }),
  );

  app.post('/api/threads/:id/messages', requirePrincipal(), async (c) => {
    const input = await body(c, z.object({ body: z.string().min(1) }));
    const principal = principalOf(c);
    // Message kind is derived from who is speaking, never client-supplied.
    const kind = principal.kind === 'agent' ? 'agent_note' : 'comment';
    const message = store.addMessage(c.req.param('id'), principal, kind, input.body);
    return c.json({ message }, 201);
  });

  /* Removing a thread is for test noise on a client-facing surface, not for review. It is
     destructive and admin-only; see `deleteThread`. */
  app.delete('/api/threads/:id', requirePrincipal('admin'), (c) => {
    store.deleteThread(c.req.param('id'));
    return c.body(null, 204);
  });

  app.post('/api/threads/:id/state', requirePrincipal(), async (c) => {
    const input = await body(
      c,
      z.object({ state: z.enum(THREAD_STATES), note: z.string().optional() }),
    );
    return c.json({
      feedback: store.setThreadState(c.req.param('id'), input.state, principalOf(c), input.note),
    });
  });

  // ── fingerprints ──────────────────────────────────────────────────────────
  app.put('/api/fingerprints', requirePrincipal(), async (c) => {
    const input = await body(
      c,
      z.object({
        storyId: z.string(),
        buildId: z.string(),
        hash: z.string().min(16),
        /** Per-region hashes observed in the same render. Absent for a story that
         *  declares no regions, which keeps every pre-existing client working. */
        regions: z
          .array(z.object({ regionKey: z.string().min(1), hash: z.string().min(16) }))
          .optional(),
      }),
    );
    // `unresolved` names regions whose story id is not in this build — a stale tile
    // id in host markup. Returned rather than thrown: the render sweep must not fail
    // over it, but it must not pass silently either.
    const report = store.putRenderReport(input.storyId, input.buildId, input);
    return c.json({ ok: true, ...report });
  });

  // ── attachments ───────────────────────────────────────────────────────────
  app.post('/api/attachments', requirePrincipal(), async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.byteLength) throw new HttpError(400, 'Empty attachment.');
    const contentType = c.req.header('content-type') ?? 'application/octet-stream';
    return c.json({ attachmentId: store.saveAttachment(bytes, contentType) }, 201);
  });

  app.get('/api/attachments/:id', requirePrincipal(), (c) => {
    const { contentType, bytes } = store.getAttachment(c.req.param('id'));
    c.header('content-type', contentType);
    return c.body(new Uint8Array(bytes));
  });

  // ── reviewers + magic links ───────────────────────────────────────────────
  app.post('/api/reviewers', requirePrincipal('admin'), async (c) => {
    const input = await body(
      c,
      z.object({
        name: z.string().min(1),
        email: z.string().min(3),
        role: z.enum(['reviewer', 'approver']).optional(),
      }),
    );
    return c.json({ reviewer: store.createReviewer(input) }, 201);
  });

  app.get('/api/reviewers', requirePrincipal('admin'), (c) =>
    c.json({ reviewers: store.listReviewers() }),
  );

  /*
   * Removing a reviewer also removes every way they had in — their links and any live
   * session. Refused outright for anyone who has commented or changed a status; see
   * `deleteReviewer` for why that refusal is the feature rather than an obstacle.
   */
  app.delete('/api/reviewers/:id', requirePrincipal('admin'), (c) => {
    store.deleteReviewer(c.req.param('id'));
    return c.body(null, 204);
  });

  app.post('/api/reviewers/:id/links', requirePrincipal('admin'), async (c) => {
    const input = await body(c, z.object({ expiresAt: z.string().optional() }).optional().default({}));
    const token = store.createMagicLink(c.req.param('id'), input.expiresAt);
    return c.json({ token, url: `${config.publicUrl}/review/${token}` }, 201);
  });

  // Listing never returns whole tokens — see `listMagicLinks`. `reviewerId` narrows to
  // one person; `includeInactive` shows revoked and expired links, which is what you
  // want when answering "why did their link stop working".
  /*
   * Re-point a comment at a host-declared anchor.
   *
   * Admin only, and rightly: it rewrites where a client's comment claims to be about.
   * The caller does the resolving, because the question can only be answered against a
   * rendered page — resolve the stored selector, read the anchor off what it lands on,
   * send the new selector here. The store keeps the original so a pass that lands on
   * the wrong card is undoable without a restore.
   */
  app.post('/api/threads/:id/reanchor', requirePrincipal('admin'), async (c) => {
    const input = await body(c, z.object({ selector: z.string().min(1).max(500) }));
    return c.json({ thread: store.reanchorThread(c.req.param('id'), input.selector) });
  });

  app.post('/api/threads/:id/restore-anchor', requirePrincipal('admin'), (c) =>
    c.json({ thread: store.restoreThreadAnchor(c.req.param('id')) }),
  );

  app.get('/api/links', requirePrincipal('admin'), (c) =>
    c.json({
      links: store.listMagicLinks({
        reviewerId: c.req.query('reviewerId') || undefined,
        includeInactive: c.req.query('includeInactive') === 'true',
      }),
    }),
  );

  /*
   * Withdraw a link and end the access it granted.
   *
   * A POST, not a DELETE: the row survives. The listing has to keep showing revoked
   * links, because "this link was withdrawn on the 14th" is the answer to a question
   * somebody will ask, and a deleted row answers nothing.
   */
  app.post('/api/links/:prefix/revoke', requirePrincipal('admin'), async (c) => {
    const input = await body(
      c,
      z.object({ endAllSessions: z.boolean().optional() }).optional().default({}),
    );
    return c.json(store.revokeMagicLink(c.req.param('prefix'), input));
  });

  app.get('/api/tokens', requirePrincipal('admin'), (c) =>
    c.json({ tokens: store.listTokens({ includeRevoked: c.req.query('includeRevoked') === 'true' }) }),
  );

  app.post('/api/tokens/:id/revoke', requirePrincipal('admin'), (c) =>
    c.json({ token: store.revokeToken(c.req.param('id')) }),
  );

  app.get('/api/me', requirePrincipal(), (c) => c.json({ principal: principalOf(c) }));

  // ── delegations + tokens (admin) ──────────────────────────────────────────
  app.post('/api/tokens', requirePrincipal('admin'), async (c) => {
    const input = await body(
      c,
      z.object({
        kind: z.enum(['admin', 'agent']),
        name: z.string().min(1),
        /** Bind the token to a reviewer, so it acts as that person rather than as an
         *  agent. For the operator driving the MCP from their own session. */
        reviewerId: z.string().optional(),
      }),
    );
    return c.json(store.createToken(input.kind, input.name, input.reviewerId), 201);
  });

  app.post('/api/delegations', requirePrincipal('admin'), async (c) => {
    const input = await body(c, z.object({ authorizationNote: z.string().min(1) }));
    return c.json({ delegation: store.createDelegation(input.authorizationNote, principalOf(c)) }, 201);
  });

  app.get('/api/delegations', requirePrincipal('admin'), (c) =>
    c.json({ delegations: store.listDelegations(), active: store.activeDelegation() }),
  );

  app.post('/api/delegations/:id/revoke', requirePrincipal('admin'), (c) => {
    store.revokeDelegation(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── audit ─────────────────────────────────────────────────────────────────
  app.get('/api/audit/export', requirePrincipal('admin'), (c) => c.json(store.auditExport()));

  // ── reviewer shell + magic-link redemption ────────────────────────────────
  const shellFile = (name: string, type: string) => {
    const file = path.join(config.shellDir, name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Shell asset missing.');
    return { bytes: new Uint8Array(fs.readFileSync(file)), type };
  };

  app.get('/review/assets/:file', (c) => {
    const name = c.req.param('file');
    if (!/^[a-z-]+\.(js|css)$/.test(name)) throw new HttpError(404, 'Not found.');
    const { bytes, type } = shellFile(name, name.endsWith('.js') ? 'text/javascript' : 'text/css');
    c.header('content-type', type);
    return c.body(bytes);
  });

  app.get('/review/', (c) => {
    const { bytes } = shellFile('index.html', 'text/html');
    c.header('content-type', 'text/html');
    // script-src 'self' (no 'unsafe-inline') blocks injected inline scripts and
    // event handlers — the XSS backstop behind our esc()/validation. Inline
    // style attributes in the shell markup need style-src 'unsafe-inline'.
    // The story preview iframe is same-origin under /builds/, so frame-src 'self'.
    c.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'",
    );
    return c.body(bytes);
  });

  // Prod runs behind HTTPS; local dev over http://localhost must still work.
  const secureCookies = config.publicUrl.startsWith('https://');

  app.get('/review/:token', (c) => {
    const { sessionId } = store.redeemMagicLink(c.req.param('token'));
    setCookie(c, SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });

    /*
     * Land the reviewer in the host's own Storybook rather than our shell.
     *
     * The build is served from this origin, so its manager is same-origin with the
     * API and the cookie just set above authenticates the addon panel with nothing to
     * configure. What the reviewer gets is the Storybook the team actually built —
     * its branding, its navigation, whatever curation and guidance it carries — with
     * review live inside it, instead of a generic surface that discards all of that.
     *
     * The original decision here was the opposite: keep the client out of the
     * Storybook manager, because the manager meant a raw sidebar of several hundred
     * entries and a row of developer tabs. That reasoning holds for an uncurated
     * Storybook, which is why the shell stays and `?surface=shell` still reaches it.
     * It stops holding the moment a host has curated one, and then the host's own
     * surface is better than ours by every measure we would use to judge it.
     */
    const wantsShell = c.req.query('surface') === 'shell';
    const build = store.latestBuild();
    if (wantsShell || !build) return c.redirect('/review/');
    return c.redirect(`/builds/${build.id}/index.html`);
  });
}
