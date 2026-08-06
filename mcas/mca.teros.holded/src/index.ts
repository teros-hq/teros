#!/usr/bin/env bun

/**
 * Holded MCA v1.0.0 (Demo Scope)
 *
 * Holded integration using McaServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 *
 * Demo features:
 * - Health check (API key validation)
 * - List contacts (GET /invoicing/v1/contacts)
 * - Get contact by ID (GET /invoicing/v1/contacts/{id})
 * - List invoices (GET /invoicing/v1/documents/invoice)
 */

import { McaServer } from '@teros/mca-sdk';
import {
  healthCheck,
  listContacts,
  getContact,
  listInvoices,
} from './tools/index.js';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.holded',
  name: 'Holded',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', healthCheck);

// =============================================================================
// REGISTER TOOLS
// =============================================================================

server.tool('list-contacts', listContacts);
server.tool('get-contact', getContact);
server.tool('list-invoices', listInvoices);

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🔷 Holded MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start Holded MCA:', error);
    process.exit(1);
  });
