import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const listSatisfactionRatings: ToolConfig = {
  description:
    'List Zendesk satisfaction ratings (CSAT scores). Returns curated rows { id, score, comment, ticketId, requesterId, createdAt }. Params: score?, limit (1-100, def 30), page.',
  parameters: {
    type: 'object',
    properties: {
      score: {
        type: 'string',
        enum: ['good', 'bad', 'offered', 'unoffered'],
        description: 'Filter by satisfaction score.',
      },
      ticketId: {
        type: 'string',
        description: 'Filter by specific ticket ID.',
      },
      limit: {
        type: 'number',
        description: 'Results per page. Min 1, max 100, default 30.',
      },
      page: {
        type: 'number',
        description: 'Page number for pagination. Default 1.',
      },
    },
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const { score, ticketId, limit, page } = args as {
      score?: string;
      ticketId?: string;
      limit?: number;
      page?: number;
    };

    const query: Record<string, string | number | undefined> = {
      per_page: Math.min(limit ?? 30, 100),
      page: page ?? 1,
    };
    if (score) query.score = score;

    let result: any;
    if (ticketId) {
      result = (await zendeskRequest(
        context,
        `/tickets/${ticketId}/satisfaction_rating.json`,
      )) as any;
      const r = result.satisfaction_rating;
      if (!r) {
        return { ratings: [], total: 0, page: 1, hasMore: false };
      }
      return {
        ratings: [
          {
            id: r.id,
            score: r.score,
            comment: r.comment,
            ticketId: r.ticket_id,
            requesterId: r.requester_id,
            groupId: r.group_id,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            url: r.url,
          },
        ],
        total: 1,
        page: 1,
        hasMore: false,
      };
    }

    result = (await zendeskRequest(context, '/satisfaction_ratings.json', {
      query,
    })) as any;

    const ratings = (result.satisfaction_ratings ?? []).map((r: any) => ({
      id: r.id,
      score: r.score,
      comment: r.comment,
      ticketId: r.ticket_id,
      requesterId: r.requester_id,
      groupId: r.group_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      url: r.url,
    }));

    return {
      ratings,
      total: ratings.length,
      page: page ?? 1,
      hasMore: result.next_page != null,
    };
  },
};
