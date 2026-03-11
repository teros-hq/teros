import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getCredentials, type SentryIssue, sentryRequest } from '../lib/index.js';

export const resolveIssue: ToolConfig = {
  description: 'Mark an issue as resolved',
  parameters: {
    type: 'object',
    properties: {
      issueId: {
        type: 'string',
        description: 'The issue ID to resolve',
      },
    },
    required: ['issueId'],
  },
  handler: async (args, context) => {
    const { authToken } = await getCredentials(context);
    const issueId = args.issueId as string;

    const result = await sentryRequest<SentryIssue>(authToken, `/issues/${issueId}/`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'resolved' }),
    });

    return {
      success: true,
      message: `Issue ${issueId} has been resolved.`,
      id: result.id,
      status: result.status,
    };
  },
};
