import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import {
  buildEmailEventQuery,
  shapeEmailEvent,
  validateEmailEventReportArgs,
} from './_helpers';

interface EmailEventReportResponse {
  events?: unknown[];
}

/**
 * get-email-event-report — GET /smtp/statistics/events.
 *
 * Per-message delivery events (delivered, opened, clicks, bounces, spam…) for
 * transactional email. Filterable by timeframe (`days` XOR `startDate`+`endDate`),
 * `email`, `event`, `messageId`, `templateId`.
 */
export const getEmailEventReport: ToolConfig = {
  description:
    'Get transactional email events from Brevo (GET /smtp/statistics/events): per-message delivery events (delivered, opened, clicks, bounces, spam, unsubscribed…). Returns { events:[{date,email,event,messageId,subject,tag,reason,link,from,templateId}], count, limit, offset }. Timeframe: pass days (1-90) OR a startDate+endDate range (YYYY-MM-DD), not both; defaults to the last 30 days. Params: limit? (1-5000, default 100), offset? (default 0), startDate?, endDate?, days?, email?, event? (bounces|hardBounces|softBounces|delivered|spam|requests|opened|clicks|invalid|deferred|blocked|unsubscribed|error|loadedByProxy), messageId?, templateId?, sort? (asc|desc, default desc).',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max events to return (1-5000, default 100).',
        default: 100,
      },
      offset: {
        type: 'number',
        description: 'Index of the first event for pagination (default 0).',
        default: 0,
      },
      startDate: {
        type: 'string',
        description: 'Start of the range (YYYY-MM-DD). Must be paired with endDate; not compatible with days.',
      },
      endDate: {
        type: 'string',
        description: 'End of the range (YYYY-MM-DD). Must be paired with startDate; not compatible with days.',
      },
      days: {
        type: 'number',
        description: 'Number of days in the past incl. today (1-90). Not compatible with startDate/endDate.',
      },
      email: {
        type: 'string',
        description: 'Filter events for a specific recipient email address.',
      },
      event: {
        type: 'string',
        description: 'Filter by event type.',
        enum: [
          'bounces',
          'hardBounces',
          'softBounces',
          'delivered',
          'spam',
          'requests',
          'opened',
          'clicks',
          'invalid',
          'deferred',
          'blocked',
          'unsubscribed',
          'error',
          'loadedByProxy',
        ],
      },
      messageId: {
        type: 'string',
        description: 'Filter events for a specific messageId.',
      },
      templateId: {
        type: 'number',
        description: 'Filter events for a specific template id.',
      },
      sort: {
        type: 'string',
        description: 'Sort by record creation: asc or desc (default desc).',
        enum: ['asc', 'desc'],
      },
    },
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    validateEmailEventReportArgs(args);
    const query = buildEmailEventQuery((args ?? {}) as Record<string, unknown>);

    const res = await brevoRequest<EmailEventReportResponse>(context, '/smtp/statistics/events', {
      query: { ...query },
    });

    const events = (res.events ?? []).map(shapeEmailEvent);
    return {
      events,
      count: events.length,
      limit: query.limit,
      offset: query.offset,
    };
  },
};
