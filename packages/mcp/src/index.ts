#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Tools (list_feedback, get_thread, reply_to_thread, mark_addressed,
// list_story_statuses, approve_stories) land in build phase 5.
const server = new McpServer({ name: 'greenroom', version: '0.0.0' });

await server.connect(new StdioServerTransport());
