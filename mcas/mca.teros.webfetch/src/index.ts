#!/usr/bin/env bun

/**
 * WebFetch MCA v1.0
 *
 * Fetch content from URLs and convert to text, markdown, or HTML format.
 * Uses McaServer with automatic transport detection.
 */

import { McaServer } from '@teros/mca-sdk';
import { webfetch } from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.webfetch',
  name: 'WebFetch',
  version: '1.0.0',
});

// =============================================================================
// REGISTER TOOLS
// =============================================================================

server.tool('webfetch', webfetch);

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[WebFetch MCA] Fatal error:', error);
  process.exit(1);
});
