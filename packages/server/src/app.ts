import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { principalMiddleware, type AppEnv } from './auth.js';
import { registerRoutes } from './routes.js';
import { createMailer, type Mailer } from './mail.js';
import { HttpError } from './util.js';

export const APP_VERSION = '0.0.0';

export function createApp(store: Store, config: Config, mailer: Mailer = createMailer(config)) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        {
          error: err.message,
          ...(err.reason ? { reason: err.reason } : {}),
          ...(err.details ? { details: err.details } : {}),
        },
        err.status as 400,
      );
    }
    console.error(err);
    return c.json({ error: 'Internal error.' }, 500);
  });

  /**
   * THE EDGE CHECK, AND IT IS FIRST ON PURPOSE.
   *
   * Greenroom's production shape is a CDN in front of a platform origin, and the
   * platforms this runs on cannot restrict who reaches that origin — Railway states
   * plainly that it offers no inbound IP allowlisting. So the origin hostname is
   * reachable by anyone who finds it, and a custom domain publishes itself in
   * Certificate Transparency within minutes of being attached. Finding it is not the
   * hard part.
   *
   * A request arriving that way skips every rule the CDN enforces: the firewall, the
   * rate limits, the security headers. This middleware is what makes those controls
   * real rather than decorative — an IP allowlist at the edge means nothing if the
   * origin answers the same request directly.
   *
   * It runs ahead of CORS, caching, `principalMiddleware` and every route, so an
   * unverified request never reaches routing, a session lookup, or the static build
   * handler.
   *
   * 404 rather than 403: a 403 announces that something is here. A 404 leaves the
   * origin indistinguishable from an empty host and stops the response telling an
   * attacker which paths exist.
   */
  if (config.edgeSecret) {
    const expected = Buffer.from(config.edgeSecret);
    app.use(async (c, next) => {
      const given = Buffer.from(c.req.header('x-origin-verify') ?? '');
      // Length is checked first because timingSafeEqual throws on a mismatch — and
      // length is not the secret, so leaking it costs nothing.
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return c.text('Not Found', 404);
      }
      await next();
    });
  }

  // Bearer-token API access from the addon panel in `storybook dev` is
  // cross-origin; reviewer cookies never ride on /api/* CORS requests because
  // the shell is served same-origin by this sidecar.
  app.use('/api/*', cors());

  /**
   * Tell every cache what it may keep. Greenroom is designed to sit behind a CDN — the
   * production deployment is CloudFront in front of a Railway origin — and until now it
   * sent no `Cache-Control` and no `Vary` at all, which left the entire decision to the
   * CDN's own configuration.
   *
   * That is not a safe place for it to live. `/api/stories` is the same URL for every
   * reviewer, so a shared cache that decided to store it would hand one reviewer another
   * reviewer's approvals and comments. Nothing would error; it would serve a plausible,
   * stale, wrong answer — the same class of failure as a false green, which is the thing
   * this tool exists to prevent. The CDN not caching it today is a property of a policy
   * somebody could change without ever looking at this service.
   *
   * `Vary` is belt and braces: `no-store` should be enough, but an intermediary that
   * ignores it still needs telling that the response depends on who asked.
   */
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
    c.header('vary', 'Authorization, Cookie');
  });

  /**
   * Build assets are the opposite case and the reason a CDN is worth having: a whole
   * Storybook, tens of megabytes, immutable once written — a build id's files are laid
   * down at ingest and never rewritten.
   *
   * `private` rather than `public`, though. These are a client's unreleased design
   * system behind a login, so the reviewer's own browser may keep them and a shared
   * cache may not. The alternative caches a confidential artifact in an edge location
   * where the authorization check no longer runs.
   */
  app.use('/builds/*', async (c, next) => {
    await next();
    /*
     * 🔴 Except the HTML. A build's assets are immutable; its index.html is not — the
     * stale-build banner is injected into it AT SERVE TIME depending on whether a newer
     * build exists. Caching it for a year meant a reviewer who bookmarked a build's URL
     * got the cached copy on every return visit and the banner never reached them: they
     * sat on an old build with the one signal that would have told them suppressed by
     * this header. Found because it happened to the client.
     */
    if (c.req.path.endsWith('.html')) {
      c.header('cache-control', 'no-store');
    } else {
      c.header('cache-control', 'private, max-age=31536000, immutable');
    }
    c.header('vary', 'Authorization, Cookie');
  });

  /** The stable address (see /latest/* in routes.ts): what it serves changes on every
   *  upload, so nothing under it may be kept. Assets are refetched under their hashed
   *  names, which dedupe against the browser's cache of /builds anyway. */
  app.use('/latest/*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
    c.header('vary', 'Authorization, Cookie');
  });

  app.use(principalMiddleware(store, config));

  /* `selfServiceLinks` is read by the reviewer gate before anyone is authenticated. The
   * gate must not offer "email me a link" when no SMTP is configured — a form that
   * silently does nothing is worse than the honest "ask your contact" it replaces. */
  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      name: 'greenroom',
      version: APP_VERSION,
      selfServiceLinks: mailer.enabled,
    }),
  );

  registerRoutes(app, store, config, mailer);

  return app;
}
