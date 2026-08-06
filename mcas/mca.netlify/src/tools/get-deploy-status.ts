/**
 * get-deploy-status — current state of a specific deploy.
 *
 * Returns DATA (state, url, errorMessage) — the renderer composes the sentence.
 */

import type { ToolConfig } from '@teros/mca-sdk';
import { NetlifyClient } from '../lib/netlify-client';

export const getDeployStatus: ToolConfig = {
  description: 'Get the current state of a Netlify deploy. Returns { state, url, errorMessage? }.',
  parameters: {
    type: 'object',
    properties: {
      siteId: {
        type: 'string',
        description: 'The Netlify site id the deploy belongs to.',
      },
      deployId: {
        type: 'string',
        description: 'The deploy id to check.',
      },
    },
    required: ['siteId', 'deployId'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const siteId = args.siteId as string;
    const deployId = args.deployId as string;

    const secrets = await context.getUserSecrets();
    const token = secrets.NETLIFY_TOKEN;
    if (!token) {
      throw new Error(
        '[AUTH_REQUIRED] No Netlify Personal Access Token configured. Add NETLIFY_TOKEN in the app settings.',
      );
    }

    const client = new NetlifyClient(token, context.signal);
    const deploy = await client.getSiteDeploy(siteId, deployId);

    return {
      state: deploy.state,
      url: deploy.ssl_url ?? deploy.deploy_ssl_url ?? null,
      errorMessage: deploy.error_message ?? null,
      deployId: deploy.id,
      siteId,
    };
  },
};
