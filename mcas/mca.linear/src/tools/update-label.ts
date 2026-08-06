import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { LABEL_FIELDS } from './_fields';
import { extractLabel, validateUuid } from './_linear-helpers';
import { resolveFields, sanitiseBody, wrapLinearCall } from './utils';

export const updateLabel: ToolConfig = {
  description:
    'Update a Linear label. Returns curated updated label. Idempotent per-field. Params: labelId, name?, color?, description?, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      labelId: { type: 'string', description: 'Label UUID.' },
      name: { type: 'string', description: 'New name.' },
      color: { type: 'string', description: "New hex color (e.g. '#FF5733')." },
      description: { type: 'string', description: 'New description.' },
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
    required: ['labelId'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const { labelId, name, color, description, fields, includeRaw } = args as {
      labelId: string;
      name?: string;
      color?: string;
      description?: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateUuid(labelId, 'labelId');

    const payload = sanitiseBody({ name, color, description });
    await wrapLinearCall(() => client.updateIssueLabel(labelId, payload as any));
    const fresh = await wrapLinearCall(() => client.issueLabel(labelId));
    const shape = extractLabel(fresh);
    if (!shape) throw new Error('Failed to extract label shape');
    return resolveFields(shape as any, fresh, {
      includeRaw,
      fields,
      defaultFields: LABEL_FIELDS,
    });
  },
};
