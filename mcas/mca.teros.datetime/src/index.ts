#!/usr/bin/env bun

/**
 * DateTime MCA v0.9.1
 *
 * Pure luxon-based date/time utilities: current clock, format/parse,
 * timezone conversion, duration arithmetic, and validation.
 *
 * Transport: `McaServer` from @teros/mca-sdk auto-detects —
 *   - `MCA_TRANSPORT=http` (container runtime, port from MCA_HTTP_PORT/PORT)
 *   - `MCA_TRANSPORT=stdio` (tool discovery via scripts/generate-mca-tools.ts)
 *   - default: http
 *
 * History: migrated from a raw StdioServerTransport server (TER-503) whose
 * manifest declared transport http — the container never got a listening
 * port and the health check killed it after 60s. This rewrite uses the SDK
 * so the manifest and the implementation agree.
 */

import { McaServer } from '@teros/mca-sdk';
import { TOOL_REGISTRY } from './tools';

const server = new McaServer({
  id: 'mca.teros.datetime',
  name: 'DateTime',
  version: '0.9.1',
});

for (const { name, tool } of TOOL_REGISTRY) {
  server.tool(name, tool);
}

server.start().catch((error) => {
  console.error('[DateTime MCA] Fatal error:', error);
  process.exit(1);
});
