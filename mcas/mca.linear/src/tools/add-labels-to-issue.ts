import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { validateIssueId, validateUuid } from './_linear-helpers';
import { wrapLinearCall } from './utils';

export const addLabelsToIssue: ToolConfig = {
  description:
    'Add labels to a Linear issue (deduped server-side against existing labels). Returns { issueId, added, total, labelIds }.',
  parameters: {
    type: 'object',
    properties: {
      issueId: { type: 'string', description: 'Issue UUID or identifier.' },
      labelIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label UUIDs to add.',
      },
    },
    required: ['issueId', 'labelIds'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'experimental' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const { issueId, labelIds } = args as { issueId: string; labelIds: string[] };
    validateIssueId(issueId);
    for (const id of labelIds) validateUuid(id, 'labelIds[]');

    const issue = await wrapLinearCall(() => client.issue(issueId));
    const existing = await issue.labels();
    const currentIds = existing.nodes.map((l: any) => l.id as string);
    const nextIds = Array.from(new Set([...currentIds, ...labelIds]));
    const added = nextIds.length - currentIds.length;

    await wrapLinearCall(() => client.updateIssue(issue.id, { labelIds: nextIds }));
    return {
      issueId: issue.id,
      identifier: issue.identifier,
      added,
      total: nextIds.length,
      labelIds: nextIds,
    };
  },
};
