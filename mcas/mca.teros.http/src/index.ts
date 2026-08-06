#!/usr/bin/env npx tsx

/**
 * HTTP Request MCA
 *
 * A single generic tool — `http-request` — that lets an agent call any public
 * REST API (Hunter.io, Brevo, Make webhooks, Apollo, Clearbit, NeverBounce, …).
 * Per-user API keys are stored as user secrets and injected via {{PLACEHOLDER}}
 * so the real value never reaches the model. Outbound requests are SSRF-safe
 * (safeFetch from @teros/mca-sdk rejects private/internal addresses).
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { httpRequest } from './tools/http-request';

const server = new McaServer({
  id: 'mca.teros.http',
  name: 'HTTP Request',
  version: '1.0.0',
});

// This MCA owns no credentials of its own — per-user API keys are optional and
// verified lazily when a tool references them. So health is just "container up".
server.tool('-health-check', {
  description: 'Internal health check tool. Reports version and uptime.',
  parameters: { type: 'object', properties: {} },
  handler: async () =>
    new HealthCheckBuilder()
      .setVersion('1.0.0')
      .setUptime(Math.floor(process.uptime()))
      .build(),
});

server.tool('http-request', httpRequest);

server.start().catch((error) => {
  console.error('[HTTP MCA] Fatal error:', error);
  process.exit(1);
});
