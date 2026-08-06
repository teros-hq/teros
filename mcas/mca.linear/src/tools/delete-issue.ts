import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { validateIssueId } from './_linear-helpers';

export const deleteIssue: ToolConfig = {
  description:
    'Permanently delete a Linear issue. Irreversible. Returns { success, issueId }.',
  parameters: {
    type: 'object',
    properties: {
      issueId: { type: 'string', description: 'Issue UUID or identifier.' },
    },
    required: ['issueId'],
  },
  annotations: { readOnlyHint: false, irreversible: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const { issueId } = args as { issueId: string };
    validateIssueId(issueId);

    const result = await client.deleteIssue(issueId);
    return { success: !!result.success, issueId };
  },
};
