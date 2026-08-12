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

  app.use(principalMiddleware(store, config));

  app.get('/api/health', (c) => c.json({ ok: true, name: 'greenroom', version: APP_VERSION }));

  registerRoutes(app, store, config);

  return app;
}
