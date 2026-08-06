import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { PROJECT_COMPACT_FIELDS } from './_fields';
import { buildProjectShape, validateUuid } from './_linear-helpers';
import { resolveFields, sanitiseBody } from './utils';

export const createProject: ToolConfig = {
  description:
    'Create a Linear project. Returns curated project shape. Not retryable (no idempotency key). Params: name, teamIds, description?, leadId?, startDate?, targetDate?, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Project name.' },
      teamIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Team UUIDs that own this project.',
      },
      description: { type: 'string', description: 'Project description.' },
      leadId: { type: 'string', description: 'Project lead UUID.' },
      startDate: { type: 'string', description: 'ISO date (YYYY-MM-DD).' },
      targetDate: { type: 'string', description: 'ISO date (YYYY-MM-DD).' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist on the returned project.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Linear project object. Default false.',
      },
    },
    required: ['name', 'teamIds'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const {
      name,
      teamIds,
      description,
      leadId,
      startDate,
      targetDate,
      fields,
      includeRaw,
    } = args as {
      name: string;
      teamIds: string[];
      description?: string;
      leadId?: string;
      startDate?: string;
      targetDate?: string;
      fields?: string[];
      includeRaw?: boolean;
    };

    for (const id of teamIds) validateUuid(id, 'teamIds[]');
    if (leadId) validateUuid(leadId, 'leadId');

    const payload = sanitiseBody({
      name,
      teamIds,
      description,
      leadId,
      startDate,
      targetDate,
    });

    const response = await client.createProject(payload as any);
    const raw = await response.project;
    if (!raw) throw new Error('Linear createProject did not return a project');
    const shape = await buildProjectShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: PROJECT_COMPACT_FIELDS,
    });
  },
};
