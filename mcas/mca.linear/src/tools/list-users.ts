import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { USER_FIELDS } from './_fields';
import { extractUser, validateUuid } from './_linear-helpers';
import { resolveFieldsList, sanitizeLimit, wrapLinearCall } from './utils';

export const listUsers: ToolConfig = {
  description:
    'List Linear workspace users. Optionally filters by team membership. Returns curated rows { id, name, displayName, email, avatarUrl, active, admin }. Params: teamId?, limit (1-100, def 50), startCursor, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      teamId: {
        type: 'string',
        description: 'Filter by team UUID (returns members of that team only).',
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
        description: 'Return raw Linear user nodes. Default false.',
      },
    },
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const { teamId, limit, startCursor, fields, includeRaw } = args as {
      teamId?: string;
      limit?: number;
      startCursor?: string;
      fields?: string[];
      includeRaw?: boolean;
    };

    if (teamId) validateUuid(teamId, 'teamId');
    const pageSize = sanitizeLimit(limit, { max: 100, default: 50 });

    let connection: any;
    if (teamId) {
      const team = await wrapLinearCall(() => client.team(teamId));
      connection = await wrapLinearCall(() =>
        team.members({
          first: pageSize,
          ...(startCursor ? { after: startCursor } : {}),
        }),
      );
    } else {
      connection = await wrapLinearCall(() =>
        client.users({
          first: pageSize,
          ...(startCursor ? { after: startCursor } : {}),
        }),
      );
    }

    const nodes: any[] = connection.nodes ?? [];
    const shaped = nodes
      .map((n) => extractUser(n))
      .filter((u: any): u is NonNullable<typeof u> => u !== null);
    const users = resolveFieldsList(shaped as any, nodes, {
      includeRaw,
      fields,
      defaultFields: USER_FIELDS,
    });

    return {
      users,
      total: users.length,
      hasMore: !!connection.pageInfo?.hasNextPage,
      nextCursor: connection.pageInfo?.endCursor ?? null,
    };
  },
};
