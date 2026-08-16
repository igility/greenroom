import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { principalMiddleware, type AppEnv } from './auth.js';
import { registerRoutes } from './routes.js';
import { HttpError } from './util.js';

export const APP_VERSION = '0.0.0';

export function createApp(store: Store, config: Config) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        { error: err.message, ...(err.reason ? { reason: err.reason } : {}) },
        err.status as 400,
      );
    }
    console.error(err);
    return c.json({ error: 'Internal error.' }, 500);
  });

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
    c.header('cache-control', 'private, max-age=31536000, immutable');
    c.header('vary', 'Authorization, Cookie');
  });

  app.use(principalMiddleware(store, config));

  app.get('/api/health', (c) => c.json({ ok: true, name: 'greenroom', version: APP_VERSION }));

  registerRoutes(app, store, config);

  return app;
}
