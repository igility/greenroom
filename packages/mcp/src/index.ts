#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SidecarClient } from './client.js';
import { buildServer } from './server.js';

const url = process.env.GREENROOM_URL;
const token = process.env.GREENROOM_TOKEN;

if (!url || !token) {
  console.error(
    'Usage: GREENROOM_URL=<sidecar url> GREENROOM_TOKEN=<agent token> greenroom-mcp',
  );
  process.exit(1);
}

const server = buildServer(new SidecarClient({ url, token }));
await server.connect(new StdioServerTransport());
