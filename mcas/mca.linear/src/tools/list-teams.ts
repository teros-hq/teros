import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { TEAM_FIELDS } from './_fields';
import { extractTeam } from './_linear-helpers';
import { resolveFieldsList, sanitizeLimit, wrapLinearCall } from './utils';

export const listTeams: ToolConfig = {
  description:
    'List Linear teams. Returns curated rows { id, name, key, icon, color, description, private }. Params: limit (1-100, def 50), startCursor, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
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
        description: 'Return raw Linear team nodes. Default false.',
      },
    },
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const { limit, startCursor, fields, includeRaw } = args as {
      limit?: number;
      startCursor?: string;
      fields?: string[];
      includeRaw?: boolean;
    };

    const pageSize = sanitizeLimit(limit, { max: 100, default: 50 });
    const connection = await wrapLinearCall(() =>
      client.teams({
        first: pageSize,
        ...(startCursor ? { after: startCursor } : {}),
      }),
    );
    const nodes = connection.nodes ?? [];
    const shaped = nodes
      .map((n: any) => extractTeam(n))
      .filter((t): t is NonNullable<typeof t> => t !== null);
    const teams = resolveFieldsList(shaped as any, nodes, {
      includeRaw,
      fields,
      defaultFields: TEAM_FIELDS,
    });

    return {
      teams,
      total: teams.length,
      hasMore: !!connection.pageInfo?.hasNextPage,
      nextCursor: connection.pageInfo?.endCursor ?? null,
    };
  },
};
