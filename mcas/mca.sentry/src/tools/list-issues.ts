import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getCredentials, getOrganization, type SentryIssue, sentryRequest } from '../lib/index.js';

export const listIssues: ToolConfig = {
  description: 'List issues (errors/problems) for a project. Can filter by status and query.',
  parameters: {
    type: 'object',
    properties: {
      organization: {
        type: 'string',
        description: 'Organization slug. Optional if configured in credentials.',
      },
      project: {
        type: 'string',
        description: 'Project slug (optional, lists all if not provided)',
      },
      query: {
        type: 'string',
        description: "Search query (e.g., 'is:unresolved', 'is:resolved', 'level:error')",
      },
      limit: {
        type: 'number',
        description: 'Maximum number of issues to return (default: 25)',
      },
    },
  },
  handler: async (args, context) => {
    const { authToken, organization: defaultOrg } = await getCredentials(context);
    const org = getOrganization(args.organization as string | undefined, defaultOrg);

    let endpoint = `/organizations/${org}/issues/`;
    const queryParams = new URLSearchParams();

    if (args.project) {
      queryParams.append('project', args.project as string);
    }
    if (args.query) {
      queryParams.append('query', args.query as string);
    }
    if (args.limit) {
      queryParams.append('limit', String(args.limit));
    }

    const queryString = queryParams.toString();
    if (queryString) {
      endpoint += `?${queryString}`;
    }

    const issues = await sentryRequest<SentryIssue[]>(authToken, endpoint);

    return issues.map((issue) => ({
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
      project: issue.project?.slug,
      platform: issue.platform,
      type: issue.type,
    }));
  },
};
