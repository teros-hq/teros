import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient, WORKSPACE_ID } from '../lib';
import { BOARD_COLUMN_FIELDS, PROJECT_FIELDS } from './_fields';
import { assertBackendConnected, pickFields, pickFieldsList, resolveFields, withTimeout } from './utils';

export const createProject: ToolConfig = {
  description:
    'Create a project with an associated Kanban board in a workspace. Returns: { project: { projectId, workspaceId, name, status, boardId }, board: { boardId, columns: [...] } }. Default columns: Backlog, To Do, In Progress, Blocked, Review, Done.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'Workspace ID (optional, defaults to execution workspace)',
      },
      name: { type: 'string', description: 'Project name' },
      description: { type: 'string', description: 'Optional project description' },
      includeRaw: { type: 'boolean', description: 'Return the full documents' },
    },
    required: ['name'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const workspaceId = (args?.workspaceId as string) || WORKSPACE_ID;
    const name = args?.name as string;
    if (!workspaceId || !name) throw new Error('workspaceId and name are required');

    const result = await withTimeout(
      wsClient.queryConversations<any>('create_project', {
        workspaceId,
        name,
        description: args?.description,
      }),
      15_000,
      'create_project',
    );

    const includeRaw = args?.includeRaw === true;
    const project = resolveFields(result.project ?? {}, {
      includeRaw,
      defaultFields: PROJECT_FIELDS,
    });
    const rawBoard = result.board;
    const board = includeRaw
      ? rawBoard
      : rawBoard
        ? {
            ...pickFields(rawBoard, ['boardId', 'projectId', 'createdAt']),
            columns: pickFieldsList(rawBoard.columns ?? [], BOARD_COLUMN_FIELDS),
          }
        : undefined;

    return { project, ...(board ? { board } : {}) };
  },
};
