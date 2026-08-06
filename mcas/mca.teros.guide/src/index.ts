#!/usr/bin/env npx tsx

/**
 * Teros Guide MCA v1.0
 *
 * Platform self-knowledge for agents. Exposes the Teros usage guide as two
 * read-only tools so an agent can look up how the platform works on demand and
 * walk the user through the real steps. See TER-583.
 */

import { McaServer } from '@teros/mca-sdk';
import { TOOLS } from './tools';

export function createGuideServer(): McaServer {
  const server = new McaServer({
    id: 'mca.teros.guide',
    name: 'Teros Guide',
    version: '1.0.0',
  });

  // Register from the single source of truth so the server and the
  // registry-sync test can never disagree on the tool surface.
  for (const tool of TOOLS) {
    server.tool(tool.name, tool.config);
  }

  return server;
}

const isDirectEntry = import.meta.url === `file://${process.argv[1]}`;
if (isDirectEntry) {
  const server = createGuideServer();
  server
    .start()
    .then(() => {
      console.error('Teros Guide MCA server running');
    })
    .catch((err) => {
      console.error('Failed to start Teros Guide MCA:', err);
      process.exit(1);
    });
}
