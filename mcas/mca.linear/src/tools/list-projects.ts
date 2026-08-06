import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { PROJECT_COMPACT_FIELDS } from './_fields';
import { extractProjectShape, validateUuid } from './_linear-helpers';
import { resolveFieldsList, sanitizeLimit, wrapLinearCall } from './utils';

export const listProjects: ToolConfig = {
  description:
    'List Linear projects. Returns curated rows { id, name, url, state, icon, color, progress, startDate, targetDate, createdAt, updatedAt }. Params: teamId?, limit (1-100, def 50), startCursor, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      teamId: { type: 'string', description: 'Filter by team UUID.' },
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
        description: 'Return raw Linear project nodes. Default false.',
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

    const filter: Record<string, any> = {};
    if (teamId) filter.accessibleTeams = { some: { id: { eq: teamId } } };

    const pageSize = sanitizeLimit(limit, { max: 100, default: 50 });
    const connection = await wrapLinearCall(() =>
      client.projects({
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        first: pageSize,
        ...(startCursor ? { after: startCursor } : {}),
      }),
    );

    const nodes = connection.nodes ?? [];
    const shaped = nodes.map((n: any) => extractProjectShape(n));
    const projects = resolveFieldsList(shaped as any, nodes, {
      includeRaw,
      fields,
      defaultFields: PROJECT_COMPACT_FIELDS,
    });

    return {
      projects,
      total: projects.length,
      hasMore: !!connection.pageInfo?.hasNextPage,
      nextCursor: connection.pageInfo?.endCursor ?? null,
    };
  },
};
