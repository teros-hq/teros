import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { LABEL_FIELDS } from './_fields';
import { extractLabel, validateUuid } from './_linear-helpers';
import { resolveFieldsList, sanitizeLimit, wrapLinearCall } from './utils';

export const listLabels: ToolConfig = {
  description:
    'List Linear labels. Returns curated rows { id, name, color, description, isGroup, parentId }. Params: teamId?, limit (1-100, def 50), startCursor, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      teamId: { type: 'string', description: 'Filter by team UUID (team-scoped labels).' },
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
        description: 'Return raw Linear label nodes. Default false.',
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
        team.labels({
          first: pageSize,
          ...(startCursor ? { after: startCursor } : {}),
        }),
      );
    } else {
      connection = await wrapLinearCall(() =>
        client.issueLabels({
          first: pageSize,
          ...(startCursor ? { after: startCursor } : {}),
        }),
      );
    }

    const nodes: any[] = connection.nodes ?? [];
    const shaped = nodes
      .map((n) => extractLabel(n))
      .filter((l: any): l is NonNullable<typeof l> => l !== null);
    const labels = resolveFieldsList(shaped as any, nodes, {
      includeRaw,
      fields,
      defaultFields: LABEL_FIELDS,
    });

    return {
      labels,
      total: labels.length,
      hasMore: !!connection.pageInfo?.hasNextPage,
      nextCursor: connection.pageInfo?.endCursor ?? null,
    };
  },
};
