import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { ISSUE_DETAIL_FIELDS } from './_fields';
import {
  buildIssueShape,
  PRIORITY_TO_NUMBER,
  validateIssueId,
  validateUuid,
} from './_linear-helpers';
import { resolveFields, sanitiseBody, wrapLinearCall } from './utils';

const PRIORITY_ENUM = ['urgent', 'high', 'medium', 'low', 'none'] as const;
type Priority = (typeof PRIORITY_ENUM)[number];

export const updateIssue: ToolConfig = {
  description:
    'Update a Linear issue. Returns curated updated issue. Idempotent per-field — safe to retry. Params: issueId, title?, description?, stateId?, assigneeId?, priority?, projectId?, labelIds?, estimate?, dueDate?, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      issueId: { type: 'string', description: 'Issue UUID or identifier.' },
      title: { type: 'string', description: 'New title.' },
      description: { type: 'string', description: 'New markdown description.' },
      stateId: { type: 'string', description: 'Workflow state UUID.' },
      assigneeId: { type: 'string', description: 'Assignee UUID (null to unassign).' },
      priority: {
        type: 'string',
        description: 'New priority.',
        enum: [...PRIORITY_ENUM],
      },
      projectId: {
        type: 'string',
        description: 'Project UUID (pass null-equivalent via remove-issues-from-project).',
      },
      labelIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Full label-id set (overwrites). Use add/remove-labels-to-issue for delta.',
      },
      estimate: { type: 'number', description: 'Point estimate.' },
      dueDate: { type: 'string', description: 'ISO date string (YYYY-MM-DD).' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist on the returned issue.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Linear issue object. Default false.',
      },
    },
    required: ['issueId'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const {
      issueId,
      title,
      description,
      stateId,
      assigneeId,
      priority,
      projectId,
      labelIds,
      estimate,
      dueDate,
      fields,
      includeRaw,
    } = args as {
      issueId: string;
      title?: string;
      description?: string;
      stateId?: string;
      assigneeId?: string;
      priority?: Priority;
      projectId?: string;
      labelIds?: string[];
      estimate?: number;
      dueDate?: string;
      fields?: string[];
      includeRaw?: boolean;
    };

    validateIssueId(issueId);
    if (stateId) validateUuid(stateId, 'stateId');
    if (assigneeId) validateUuid(assigneeId, 'assigneeId');
    if (projectId) validateUuid(projectId, 'projectId');

    const payload = sanitiseBody({
      title,
      description,
      stateId,
      assigneeId,
      projectId,
      labelIds,
      estimate,
      dueDate,
      priority: priority ? PRIORITY_TO_NUMBER[priority] : undefined,
    });

    await wrapLinearCall(() => client.updateIssue(issueId, payload as any));
    const fresh = await wrapLinearCall(() => client.issue(issueId));
    const shape = await buildIssueShape(fresh);
    return resolveFields(shape as any, fresh, {
      includeRaw,
      fields,
      defaultFields: ISSUE_DETAIL_FIELDS,
    });
  },
};
