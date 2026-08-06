import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { assertBackendConnected, withTimeout } from './utils';

export const updateBoardConfig: ToolConfig = {
  description:
    'Update the board execution config for a project. The config object is passed as-is to the board. Currently reserved for future auto-dispatcher settings. Returns: { projectId, config }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID' },
      config: {
        type: 'object',
        description: 'Board config object (passed as-is to the board document)',
        additionalProperties: true,
      },
    },
    required: ['projectId', 'config'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const projectId = args?.projectId as string;
    const config = args?.config as Record<string, unknown>;
    if (!projectId) {
      throw new Error('projectId is required');
    }
    if (!config || typeof config !== 'object') {
      throw new Error('config is required and must be an object');
    }

    const result = await withTimeout(
      wsClient.queryConversations<any>('update_board_config', {
        projectId,
        config,
      }),
      15_000,
      'update_board_config',
    );

    return { projectId, config: result.config };
  },
};
