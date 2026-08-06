import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { validateUuid } from './_linear-helpers';

export const deleteLabel: ToolConfig = {
  description:
    'Permanently delete a Linear label. Irreversible. Returns { success, labelId }.',
  parameters: {
    type: 'object',
    properties: {
      labelId: { type: 'string', description: 'Label UUID.' },
    },
    required: ['labelId'],
  },
  annotations: { readOnlyHint: false, irreversible: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const { labelId } = args as { labelId: string };
    validateUuid(labelId, 'labelId');

    const result = await client.deleteIssueLabel(labelId);
    return { success: !!result.success, labelId };
  },
};
