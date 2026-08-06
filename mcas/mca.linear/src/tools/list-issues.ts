import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { ISSUE_COMPACT_FIELDS } from './_fields';
import {
  buildIssueListShape,
  PRIORITY_TO_NUMBER,
  validateUuid,
} from './_linear-helpers';
import { resolveFieldsList, sanitizeLimit, wrapLinearCall } from './utils';

const STATUS_ENUM = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const;
type StatusFilter = (typeof STATUS_ENUM)[number];
const PRIORITY_ENUM = ['urgent', 'high', 'medium', 'low', 'none'] as const;
type PriorityFilter = (typeof PRIORITY_ENUM)[number];

export const listIssues: ToolConfig = {
  description:
    'List Linear issues with optional filters. Returns curated rows { id, identifier, title, url, status, priority, assignee, team, createdAt, updatedAt }. Params: teamId?, status?, assigneeId?, priority?, limit (1-100, def 50), startCursor, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      teamId: { type: 'string', description: 'Filter by team UUID.' },
      status: {
        type: 'string',
        description: 'Filter by workflow state type.',
        enum: [...STATUS_ENUM],
      },
      assigneeId: { type: 'string', description: 'Filter by assignee UUID.' },
      priority: {
        type: 'string',
        description: 'Filter by priority.',
        enum: [...PRIORITY_ENUM],
      },
      limit: {
        type: 'number',
        description: 'Results per page. Min 1, max 100, default 50.',
      },
      startCursor: {
        type: 'string',
        description: 'Linear relay cursor from previous response.nextCursor.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist per row.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Linear issue nodes. Default false.',
      },
    },
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const {
      teamId,
      status,
      assigneeId,
      priority,
      limit,
      startCursor,
      fields,
      includeRaw,
    } = args as {
      teamId?: string;
      status?: StatusFilter;
      assigneeId?: string;
      priority?: PriorityFilter;
      limit?: number;
      startCursor?: string;
      fields?: string[];
      includeRaw?: boolean;
    };

    if (teamId) validateUuid(teamId, 'teamId');
    if (assigneeId) validateUuid(assigneeId, 'assigneeId');

    const filter: Record<string, any> = {};
    if (teamId) filter.team = { id: { eq: teamId } };
    if (assigneeId) filter.assignee = { id: { eq: assigneeId } };
    if (status) filter.state = { type: { eq: status } };
    if (priority) filter.priority = { eq: PRIORITY_TO_NUMBER[priority] };

    const pageSize = sanitizeLimit(limit, { max: 100, default: 50 });
    const connection = await wrapLinearCall(() =>
      client.issues({
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        first: pageSize,
        ...(startCursor ? { after: startCursor } : {}),
      }),
    );

    const nodes = connection.nodes ?? [];
    const shaped = await Promise.all(nodes.map((n: any) => buildIssueListShape(n)));
    const issues = resolveFieldsList(shaped as any, nodes, {
      includeRaw,
      fields,
      defaultFields: ISSUE_COMPACT_FIELDS,
    });

    return {
      issues,
      total: issues.length,
      hasMore: !!connection.pageInfo?.hasNextPage,
      nextCursor: connection.pageInfo?.endCursor ?? null,
    };
  },
};
