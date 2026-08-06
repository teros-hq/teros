import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { validateIssueId } from './_linear-helpers';
import { wrapLinearCall } from './utils';

export const removeIssuesFromProject: ToolConfig = {
  description:
    'Detach one or more Linear issues from their project. Returns { removed, failed, results: [{ issueId, identifier?, success, error? }] }.',
  parameters: {
    type: 'object',
    properties: {
      issueIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Issue UUIDs or identifiers to detach.',
      },
    },
    required: ['issueIds'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'experimental' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const { issueIds } = args as { issueIds: string[] };

    const results: {
      issueId: string;
      identifier?: string;
      success: boolean;
      error?: string;
    }[] = [];

    for (const issueId of issueIds) {
      try {
        validateIssueId(issueId);
        // Linear accepts empty string / null to detach — SDK v29 expects `projectId: null`.
        await wrapLinearCall(() =>
          client.updateIssue(issueId, { projectId: null as any }),
        );
        const issue = await wrapLinearCall(() => client.issue(issueId));
        results.push({ issueId, identifier: issue.identifier, success: true });
      } catch (error: any) {
        results.push({ issueId, success: false, error: error?.message ?? String(error) });
      }
    }

    const removed = results.filter((r) => r.success).length;
    const failed = results.length - removed;
    return { removed, failed, results };
  },
};
