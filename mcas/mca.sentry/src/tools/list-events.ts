import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getCredentials, type SentryEvent, sentryRequest } from '../lib/index.js';

export const listEvents: ToolConfig = {
  description: 'List events (individual error occurrences) for an issue',
  parameters: {
    type: 'object',
    properties: {
      issueId: {
        type: 'string',
        description: 'The issue ID to get events for',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of events to return (default: 25)',
      },
    },
    required: ['issueId'],
  },
  handler: async (args, context) => {
    const { authToken } = await getCredentials(context);
    const issueId = args.issueId as string;

    let endpoint = `/issues/${issueId}/events/`;
    if (args.limit) {
      endpoint += `?limit=${args.limit}`;
    }

    const events = await sentryRequest<SentryEvent[]>(authToken, endpoint);

    return events.map((event) => ({
      eventID: event.eventID,
      id: event.id,
      title: event.title,
      message: event.message,
      dateCreated: event.dateCreated,
      user: event.user,
      tags: event.tags,
      platform: event.platform,
    }));
  },
};
