import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient, WORKSPACE_ID } from '../lib';
import { PROJECT_FIELDS } from './_fields';
import { assertBackendConnected, paginate, resolveFieldsList, withRetry, withTimeout } from './utils';

export const listProjects: ToolConfig = {
  description:
    'List projects in a workspace. Returns: { workspaceId, projects: [{ projectId, name, description, status, boardId, taskCount, activeAgentCount, createdAt }], nextCursor? }. Paginated: default 50, max 200. Use get-project for full detail + board columns.',
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'Workspace ID (optional, defaults to execution workspace)',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Custom subset of fields',
      },
      includeArchived: { type: 'boolean', description: 'Include archived projects (default: false)' },
      includeRaw: { type: 'boolean', description: 'Return full project documents' },
      limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
    },
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const workspaceId = (args?.workspaceId as string) || WORKSPACE_ID;
    if (!workspaceId) throw new Error('workspaceId is required (no execution workspace available)');

    const includeArchived = args?.includeArchived as boolean | undefined;

    const result = await withRetry(
      () =>
        withTimeout(
          wsClient.queryConversations<any>('list_projects', { workspaceId, includeArchived }),
          15_000,
          'list_projects',
        ),
      { retries: 2, delayMs: 500, label: 'list_projects' },
    );

    const { items, nextCursor } = paginate(
      (result.projects ?? []) as Record<string, unknown>[],
      args?.limit as number | undefined,
      args?.cursor as string | undefined,
    );
    const projects = resolveFieldsList(items, {
      includeRaw: args?.includeRaw === true,
      fields: args?.fields as string[] | undefined,
      defaultFields: PROJECT_FIELDS,
    });

    return {
      workspaceId: result.workspaceId ?? workspaceId,
      projects,
      ...(nextCursor ? { nextCursor } : {}),
    };
  },
};
