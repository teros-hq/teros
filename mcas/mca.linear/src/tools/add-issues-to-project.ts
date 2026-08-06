import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { validateIssueId, validateUuid } from './_linear-helpers';
import { wrapLinearCall } from './utils';

export const addIssuesToProject: ToolConfig = {
  description:
    'Attach one or more Linear issues to a project. Returns { projectId, added, failed, results: [{ issueId, identifier?, success, error? }] }.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project UUID.' },
      issueIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Issue UUIDs or identifiers.',
      },
    },
    required: ['projectId', 'issueIds'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'experimental' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const { projectId, issueIds } = args as { projectId: string; issueIds: string[] };
    validateUuid(projectId, 'projectId');

    const results: {
      issueId: string;
      identifier?: string;
      success: boolean;
      error?: string;
    }[] = [];

    for (const issueId of issueIds) {
      try {
        validateIssueId(issueId);
        await wrapLinearCall(() => client.updateIssue(issueId, { projectId }));
        const issue = await wrapLinearCall(() => client.issue(issueId));
        results.push({ issueId, identifier: issue.identifier, success: true });
      } catch (error: any) {
        results.push({ issueId, success: false, error: error?.message ?? String(error) });
      }
    }

    const added = results.filter((r) => r.success).length;
    const failed = results.length - added;
    return { projectId, added, failed, results };
  },
};
