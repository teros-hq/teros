import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { BOARD_COLUMN_FIELDS, PROJECT_FIELDS } from './_fields';
import {
  assertBackendConnected,
  pickFields,
  pickFieldsList,
  resolveFields,
  withRetry,
  withTimeout,
} from './utils';

export const getProject: ToolConfig = {
  description:
    'Get project detail + its board columns. Returns: { project: { projectId, name, description, context, status, boardId, createdAt }, board: { boardId, columns: [{ columnId, slug, name, position }] } }. Use list-tasks to enumerate tasks.',
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Custom subset for project' },
      includeRaw: { type: 'boolean', description: 'Return full project + board' },
    },
    required: ['projectId'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const projectId = args?.projectId as string;
    if (!projectId) throw new Error('projectId is required');

    const result = await withRetry(
      () =>
        withTimeout(
          wsClient.queryConversations<any>('get_project', { projectId }),
          15_000,
          'get_project',
        ),
      { retries: 2, delayMs: 500, label: 'get_project' },
    );

    const includeRaw = args?.includeRaw === true;
    const fields = args?.fields as string[] | undefined;

    const project = resolveFields(result.project ?? {}, {
      includeRaw,
      fields,
      defaultFields: PROJECT_FIELDS,
    });

    const rawBoard = result.board;
    const board = includeRaw
      ? rawBoard
      : rawBoard
        ? {
            ...pickFields(rawBoard, ['boardId', 'projectId', 'createdAt', 'updatedAt']),
            columns: pickFieldsList(rawBoard.columns ?? [], BOARD_COLUMN_FIELDS),
          }
        : undefined;

    return { project, ...(board ? { board } : {}) };
  },
};
