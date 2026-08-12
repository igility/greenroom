import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { HttpError } from './util.js';
import { requirePrincipal, principalOf, SESSION_COOKIE, type AppEnv } from './auth.js';

const STORY_STATES = ['in_review', 'changes_requested', 'addressed', 'approved', 'needs_reconfirm'] as const;
const THREAD_STATES = ['open', 'addressed', 'resolved'] as const;

const pinSchema = z.object({
  selector: z.string(),
  x: z.number(),
  y: z.number(),
  viewportWidth: z.number(),
  viewportHeight: z.number(),
});

const MIME: Record<string, string> = {
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

export function registerRoutes(app: Hono<AppEnv>, store: Store, config: Config) {
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
    const result = store.ingestBuildZip(bytes, { label, gitSha }, principalOf(c));
    return c.json(result, result.created ? 201 : 200);
  });

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
    return c.body(new Uint8Array(fs.readFileSync(filePath)));
  });

  // ── stories + status ──────────────────────────────────────────────────────
  app.get('/api/stories', requirePrincipal(), (c) => {
    const state = c.req.query('state') as (typeof STORY_STATES)[number] | undefined;
    if (state && !STORY_STATES.includes(state)) throw new HttpError(400, `Unknown state ${state}.`);
    return c.json({ stories: store.listStories({ state }) });
  });

  app.get('/api/stories/:storyId', requirePrincipal(), (c) =>
    c.json({ story: store.getStory(c.req.param('storyId')) }),
  );

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

  app.get('/api/reconfirm-queue', requirePrincipal(), (c) => {
    const buildId = c.req.query('buildId') ?? store.latestBuild()?.id;
    if (!buildId) throw new HttpError(400, 'No builds uploaded yet.');
    return c.json({ buildId, items: store.reconfirmQueue(buildId) });
  });

  // ── threads + feedback ────────────────────────────────────────────────────
  app.post('/api/threads', requirePrincipal(), async (c) => {
    const input = await body(
      c,
      z.object({
        storyId: z.string(),
        buildId: z.string(),
        body: z.string().min(1),
        pin: pinSchema.optional(),
        args: z.record(z.string(), z.unknown()).optional(),
        screenshotAttachmentId: z.string().optional(),
      }),
    );
    return c.json({ feedback: store.createThread(input, principalOf(c)) }, 201);
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
      z.object({ storyId: z.string(), buildId: z.string(), hash: z.string().min(16) }),
    );
    store.putFingerprint(input.storyId, input.buildId, input.hash);
    return c.json({ ok: true });
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

  app.post('/api/reviewers/:id/links', requirePrincipal('admin'), async (c) => {
    const input = await body(c, z.object({ expiresAt: z.string().optional() }).optional().default({}));
    const token = store.createMagicLink(c.req.param('id'), input.expiresAt);
    return c.json({ token, url: `${config.publicUrl}/review/${token}` }, 201);
  });

  app.get('/api/me', requirePrincipal(), (c) => c.json({ principal: principalOf(c) }));

  // ── delegations + tokens (admin) ──────────────────────────────────────────
  app.post('/api/tokens', requirePrincipal('admin'), async (c) => {
    const input = await body(c, z.object({ kind: z.enum(['admin', 'agent']), name: z.string().min(1) }));
    return c.json(store.createToken(input.kind, input.name), 201);
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
    return c.redirect('/review/');
  });
}
