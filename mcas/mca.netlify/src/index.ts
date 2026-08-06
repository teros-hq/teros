#!/usr/bin/env npx tsx

/**
 * Netlify MCA — deploy static sites to Netlify from the workspace.
 *
 * Tools:
 * - deploy-site: digest + upload + poll a workspace dir to Netlify, return URL
 * - list-sites: list the user's Netlify sites
 * - get-deploy-status: state of a specific deploy
 * - -health-check: validate the per-user Personal Access Token
 *
 * Auth: per-user Netlify Personal Access Token (NETLIFY_TOKEN), Bearer header.
 * Uses McaServer from @teros/mca-sdk for automatic transport detection.
 */

import { McaServer } from '@teros/mca-sdk';
import { deploySite } from './tools/deploy-site';
import { getDeployStatus } from './tools/get-deploy-status';
import { healthCheck } from './tools/health-check';
import { listSites } from './tools/list-sites';

const server = new McaServer({
  id: 'mca.netlify',
  name: 'Netlify',
  version: '1.0.0',
});

server.tool('-health-check', healthCheck);
server.tool('deploy-site', deploySite);
server.tool('list-sites', listSites);
server.tool('get-deploy-status', getDeployStatus);

server.start().catch((error) => {
  console.error('[Netlify MCA] Fatal error:', error);
  process.exit(1);
});
