import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

/**
 * Read the current GitHub API rate-limit budget for the installation token.
 * Useful for autorun decisions ("do I have budget for a 50-call batch?").
 *
 * Returns `{ resources: { core, search, graphql, code_search,
 * integration_manifest, code_scanning_upload }, rate }`. Each bucket has
 * `{ limit, remaining, reset, used }`. `reset` is unix epoch seconds.
 */
export const getRateLimit: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Read the current GitHub API rate-limit budget for the installation token. Returns per-bucket {limit, remaining, reset, used} — core, search, graphql, code_search.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    return await githubRequest(context, '/rate_limit');
  },
};
