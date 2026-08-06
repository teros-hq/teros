import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { ISSUE_DETAIL_FIELDS } from './_fields';
import { buildIssueShape, validateIssueId } from './_linear-helpers';
import { resolveFields, wrapLinearCall } from './utils';

export const getIssue: ToolConfig = {
  description:
    'Retrieve a Linear issue by UUID or identifier (e.g. "TER-123"). Returns curated { id, identifier, title, url, status, priority, assignee, team, project, cycle, labels, description, createdAt, updatedAt }. Params: issueId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      issueId: {
        type: 'string',
        description: 'Issue UUID or human identifier (e.g. "TER-123").',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Linear issue object. Default false.',
      },
    },
    required: ['issueId'],
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const { issueId, fields, includeRaw } = args as {
      issueId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateIssueId(issueId);

    const raw = await wrapLinearCall(() => client.issue(issueId));
    const shape = await buildIssueShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: ISSUE_DETAIL_FIELDS,
    });
  },
};
