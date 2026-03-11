import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { intercomRequest } from '../lib';

export const searchConversations: ToolConfig = {
  description:
    'Search conversations in Intercom with filters by state, date range, tags, and assignee. Returns paginated results with conversation metadata.',
  parameters: {
    type: 'object',
    properties: {
      state: {
        type: 'string',
        enum: ['open', 'closed', 'snoozed'],
        description: 'Filter by conversation state',
      },
      createdAfter: {
        type: 'number',
        description: 'Unix timestamp — only conversations created after this time',
      },
      createdBefore: {
        type: 'number',
        description: 'Unix timestamp — only conversations created before this time',
      },
      assigneeId: {
        type: 'string',
        description: 'Filter by assigned admin ID',
      },
      teamId: {
        type: 'string',
        description: 'Filter by assigned team ID',
      },
      perPage: {
        type: 'number',
        description: 'Results per page (default: 20, max: 50)',
      },
      startingAfter: {
        type: 'string',
        description: 'Pagination cursor from previous response',
      },
    },
  },
  handler: async (args, context) => {
    const { state, createdAfter, createdBefore, assigneeId, teamId, perPage = 20, startingAfter } =
      args as {
        state?: string;
        createdAfter?: number;
        createdBefore?: number;
        assigneeId?: string;
        teamId?: string;
        perPage?: number;
        startingAfter?: string;
      };

    const conditions: unknown[] = [];

    if (state) conditions.push({ field: 'state', operator: '=', value: state });
    if (createdAfter) conditions.push({ field: 'created_at', operator: '>', value: createdAfter });
    if (createdBefore) conditions.push({ field: 'created_at', operator: '<', value: createdBefore });
    if (assigneeId) conditions.push({ field: 'assignee_id', operator: '=', value: assigneeId });
    if (teamId) conditions.push({ field: 'team_assignee_id', operator: '=', value: teamId });

    const query =
      conditions.length === 1
        ? conditions[0]
        : conditions.length > 1
          ? { operator: 'AND', value: conditions }
          : {};

    const pagination: Record<string, unknown> = { per_page: Math.min(perPage, 50) };
    if (startingAfter) pagination.starting_after = startingAfter;

    const result = (await intercomRequest(context, '/conversations/search', {
      method: 'POST',
      body: { query, pagination },
    })) as Record<string, unknown>;

    // Simplify output for the agent
    const conversations = (result.conversations as any[]) ?? [];
    return {
      totalPages: (result.pages as any)?.total_pages,
      nextCursor: (result.pages as any)?.next?.starting_after ?? null,
      count: conversations.length,
      conversations: conversations.map((c) => ({
        id: c.id,
        state: c.state,
        priority: c.priority,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        source: c.source?.type,
        subject: c.source?.subject,
        assignee: c.assignee?.name ?? null,
        team: c.team_assignee?.name ?? null,
        tags: (c.tags?.tags ?? []).map((t: any) => t.name),
      })),
    };
  },
};
