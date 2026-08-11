#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const command = process.argv[2] ?? 'serve';

if (command === 'serve') {
  const port = Number(process.env.GREENROOM_PORT ?? 4788);
  serve({ fetch: createApp().fetch, port }, (info) => {
    console.log(`greenroom sidecar listening on http://localhost:${info.port}`);
  });
} else {
  console.error(`Unknown command: ${command}\nUsage: greenroom [serve]`);
  process.exit(1);
}
