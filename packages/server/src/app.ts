import { Hono } from 'hono';

export const APP_VERSION = '0.0.0';

export function createApp() {
  const app = new Hono();

  app.get('/api/health', (c) =>
    c.json({ ok: true, name: 'greenroom', version: APP_VERSION }),
  );

  return app;
}
