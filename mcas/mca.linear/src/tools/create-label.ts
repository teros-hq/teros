import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { LABEL_FIELDS } from './_fields';
import { extractLabel, validateUuid } from './_linear-helpers';
import { resolveFields, sanitiseBody } from './utils';

export const createLabel: ToolConfig = {
  description:
    "Create a Linear label. Returns curated { id, name, color, description }. Not retryable. Params: name, teamId, color?, description?, fields?, includeRaw.",
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Label name.' },
      teamId: { type: 'string', description: 'Team UUID that owns the label.' },
      color: {
        type: 'string',
        description: "Hex color (e.g. '#FF5733').",
      },
      description: { type: 'string', description: 'Label description.' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist on the returned label.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Linear label object. Default false.',
      },
    },
    required: ['name', 'teamId'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const { name, teamId, color, description, fields, includeRaw } = args as {
      name: string;
      teamId: string;
      color?: string;
      description?: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateUuid(teamId, 'teamId');

    const payload = sanitiseBody({ name, teamId, color, description });
    const response = await client.createIssueLabel(payload as any);
    const raw = await response.issueLabel;
    if (!raw) throw new Error('Linear createIssueLabel did not return a label');
    const shape = extractLabel(raw);
    if (!shape) throw new Error('Failed to extract label shape');
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: LABEL_FIELDS,
    });
  },
};
