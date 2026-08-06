import type { LinearClient } from '@linear/sdk';
import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { ISSUE_COMPACT_FIELDS } from './_fields';
import {
  buildIssueShape,
  cleanOptionalString,
  isUuid,
  PRIORITY_TO_NUMBER,
  validateIssueId,
  validateUuid,
} from './_linear-helpers';
import { resolveFields, sanitiseBody, wrapLinearCall } from './utils';

const PRIORITY_ENUM = ['urgent', 'high', 'medium', 'low', 'none'] as const;
type Priority = (typeof PRIORITY_ENUM)[number];

/**
 * Resolve a Linear `parentId` arg into the UUID expected by `IssueCreateInput`.
 * Accepts either a UUID (passthrough) or a human identifier like `TER-123`,
 * which is looked up via `client.issue(id)`. Returns `undefined` when the input
 * is missing/blank — boundary normalisation keeps `""` from reaching the API.
 */
async function resolveParentId(
  client: LinearClient,
  parentInput: string | undefined,
): Promise<string | undefined> {
  if (!parentInput) return undefined;
  validateIssueId(parentInput, 'parentId');
  if (isUuid(parentInput)) return parentInput;
  const parentIssue = await wrapLinearCall(() => client.issue(parentInput));
  if (!parentIssue?.id) {
    throw new Error(`Linear parent issue "${parentInput}" not found`);
  }
  return parentIssue.id;
}

export const createIssue: ToolConfig = {
  description:
    'Create a Linear issue. Returns curated { id, identifier, title, url, status, priority, assignee, team, createdAt, updatedAt }. Not retryable (no idempotency key). Params: title, teamId, description?, assigneeId?, priority?, projectId?, labelIds?, stateId?, parentId? (UUID or "TER-123"), fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Issue title.' },
      teamId: { type: 'string', description: 'Team UUID (required).' },
      description: { type: 'string', description: 'Markdown description.' },
      assigneeId: { type: 'string', description: 'Assignee UUID.' },
      priority: {
        type: 'string',
        description: 'Issue priority.',
        enum: [...PRIORITY_ENUM],
      },
      projectId: { type: 'string', description: 'Project UUID.' },
      labelIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label UUIDs to attach on creation.',
      },
      stateId: { type: 'string', description: 'Workflow state UUID to set initially.' },
      parentId: {
        type: 'string',
        description:
          'Parent issue UUID or identifier (e.g. "TER-123"). Only set when creating a sub-task; omit otherwise.',
      },
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
    required: ['title', 'teamId'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const raw = args as {
      title: string;
      teamId: string;
      description?: string;
      assigneeId?: string;
      priority?: Priority;
      projectId?: string;
      labelIds?: string[];
      stateId?: string;
      parentId?: string;
      fields?: string[];
      includeRaw?: boolean;
    };

    const teamId = raw.teamId;
    const description = cleanOptionalString(raw.description);
    const assigneeId = cleanOptionalString(raw.assigneeId);
    const projectId = cleanOptionalString(raw.projectId);
    const stateId = cleanOptionalString(raw.stateId);

    validateUuid(teamId, 'teamId');
    if (assigneeId) validateUuid(assigneeId, 'assigneeId');
    if (projectId) validateUuid(projectId, 'projectId');
    if (stateId) validateUuid(stateId, 'stateId');

    const parentId = await resolveParentId(client, cleanOptionalString(raw.parentId));

    const payload = sanitiseBody({
      title: raw.title,
      teamId,
      description,
      assigneeId,
      projectId,
      labelIds: raw.labelIds,
      stateId,
      parentId,
      priority: raw.priority ? PRIORITY_TO_NUMBER[raw.priority] : undefined,
    });

    const response = await client.createIssue(payload as any);
    const created = await response.issue;
    if (!created) throw new Error('Linear createIssue did not return an issue');
    const shape = await buildIssueShape(created);
    return resolveFields(shape as any, created, {
      includeRaw: raw.includeRaw,
      fields: raw.fields,
      defaultFields: ISSUE_COMPACT_FIELDS,
    });
  },
};
