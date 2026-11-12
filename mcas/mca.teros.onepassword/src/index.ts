#!/usr/bin/env bun

/**
 * 1Password MCA v1.0.0
 *
 * Read-only 1Password access for Teros agents via a Service Account token.
 *
 * Tools:
 * - -health-check (token present + valid)
 * - list-vaults (vaults the Service Account can access)
 * - list-items (items in a vault: titles + categories)
 * - get-item-fields (item fields INCLUDING secret values)
 *
 * Uses the official @1password/sdk (encrypted session protocol against
 * 1Password's hosted endpoint — not plain REST, see lib/onepassword-client.ts).
 *
 * SECURITY: secret values are returned to the calling agent for the requested
 * action only (e.g. writing a secrets file). They must not be logged or
 * persisted beyond that — see README "Security".
 */

import { McaServer } from '@teros/mca-sdk';
import { healthCheck, listVaults, listItems, getItemFields } from './tools/index.js';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.onepassword',
  name: '1Password',
  version: '1.0.0',
});

// =============================================================================
// REGISTER TOOLS
// =============================================================================

server.tool('-health-check', healthCheck);
server.tool('list-vaults', listVaults);
server.tool('list-items', listItems);
server.tool('get-item-fields', getItemFields);

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🔐 1Password MCA server running (v1.0.0 — read-only vault/item access)');
  })
  .catch((error) => {
    console.error('Failed to start 1Password MCA:', error);
    process.exit(1);
  });
