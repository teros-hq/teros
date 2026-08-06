import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

/**
 * Trigger a `repository_dispatch` event. The repo must have a workflow
 * configured with `on: repository_dispatch` (optionally filtered by
 * `types: [<event_type>]`). Cleaner than `trigger-workflow` for arbitrary
 * CI hooks because it doesn't require the workflow to expose
 * `workflow_dispatch` inputs.
 */
export const dispatchEvent: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Send a `repository_dispatch` event to trigger workflows configured to listen for it. Pass `event_type` (string the workflow filters on) and optional `client_payload`.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      event_type: {
        type: 'string',
        description: 'Custom event type the workflow filters on (e.g. `deploy-staging`)',
      },
      client_payload: {
        type: 'object',
        description: 'Optional payload (max 10 properties, JSON-serializable). Available to the workflow as `github.event.client_payload`.',
      },
    },
    required: ['owner', 'repo', 'event_type'],
  },
  handler: async (args, context) => {
    const { owner, repo, event_type, client_payload } = args as {
      owner: string;
      repo: string;
      event_type: string;
      client_payload?: Record<string, unknown>;
    };

    if (!event_type || event_type.trim() === '') {
      throw new Error('`event_type` must be a non-empty string.');
    }

    return await githubRequest(context, `/repos/${owner}/${repo}/dispatches`, {
      method: 'POST',
      body: { event_type, client_payload },
    });
  },
};
