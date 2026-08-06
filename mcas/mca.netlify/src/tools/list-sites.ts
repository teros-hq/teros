/**
 * list-sites — list the Netlify sites the user's token can access.
 *
 * Returns DATA (ids, names, urls) — the renderer composes the list UI.
 */

import type { ToolConfig } from '@teros/mca-sdk';
import { NetlifyClient } from '../lib/netlify-client';

export const listSites: ToolConfig = {
  description: 'List the Netlify sites reachable with the configured token. Returns { sites: [{ id, name, url, ssl_url }] }.',
  parameters: {
    type: 'object',
    properties: {},
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, openWorldHint: true },
  handler: async (_args, context) => {
    const secrets = await context.getUserSecrets();
    const token = secrets.NETLIFY_TOKEN;
    if (!token) {
      throw new Error(
        '[AUTH_REQUIRED] No Netlify Personal Access Token configured. Add NETLIFY_TOKEN in the app settings.',
      );
    }

    const client = new NetlifyClient(token, context.signal);
    const sites = await client.listSites();

    return {
      sites: sites.map((s) => ({
        id: s.id,
        name: s.name,
        url: s.url ?? null,
        ssl_url: s.ssl_url ?? null,
      })),
    };
  },
};
