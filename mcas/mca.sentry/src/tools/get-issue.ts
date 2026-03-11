import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getCredentials, type SentryIssue, sentryRequest } from '../lib/index.js';

export const getIssue: ToolConfig = {
  description: 'Get detailed information about a specific issue',
  parameters: {
    type: 'object',
    properties: {
      issueId: {
        type: 'string',
        description: 'The issue ID',
      },
    },
    required: ['issueId'],
  },
  handler: async (args, context) => {
    const { authToken } = await getCredentials(context);
    const issueId = args.issueId as string;

    const issue = await sentryRequest<SentryIssue>(authToken, `/issues/${issueId}/`);

    return {
      id: issue.id,
      shortId: issue.shortId,
      title: issue.title,
      culprit: issue.culprit,
      level: issue.level,
      status: issue.status,
      count: issue.count,
      userCount: issue.userCount,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      project: issue.project,
      metadata: issue.metadata,
      type: issue.type,
      annotations: issue.annotations,
      assignedTo: issue.assignedTo,
      isSubscribed: issue.isSubscribed,
      hasSeen: issue.hasSeen,
      permalink: issue.permalink,
    };
  },
};
