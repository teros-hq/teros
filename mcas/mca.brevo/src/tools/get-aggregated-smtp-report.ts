import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import {
  buildAggregatedReportQuery,
  shapeAggregatedReport,
  validateAggregatedReportArgs,
} from './_helpers';

/**
 * get-aggregated-smtp-report — GET /smtp/statistics/aggregatedReport.
 *
 * Totals for transactional email over a timeframe (requests, delivered, opens,
 * clicks, bounces, spam, unsubscribed…). Timeframe: `days` XOR
 * `startDate`+`endDate`; optional `tag` filter.
 */
export const getAggregatedSmtpReport: ToolConfig = {
  description:
    'Get aggregated transactional email stats from Brevo (GET /smtp/statistics/aggregatedReport): totals over a timeframe. Returns { range, requests, delivered, opens, uniqueOpens, clicks, uniqueClicks, hardBounces, softBounces, blocked, invalid, spamReports, unsubscribed }. Timeframe: pass days (1-90) OR a startDate+endDate range (YYYY-MM-DD), not both; defaults to the last 90 days. Params: startDate?, endDate?, days?, tag? (filter by email tag).',
  parameters: {
    type: 'object',
    properties: {
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
      tag: {
        type: 'string',
        description: 'Filter the totals for a specific email tag.',
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
    validateAggregatedReportArgs(args);
    const query = buildAggregatedReportQuery((args ?? {}) as Record<string, unknown>);

    const res = await brevoRequest<unknown>(context, '/smtp/statistics/aggregatedReport', {
      query: { ...query },
    });

    return shapeAggregatedReport(res);
  },
};
