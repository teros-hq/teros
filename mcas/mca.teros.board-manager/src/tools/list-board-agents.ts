import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient, WORKSPACE_ID } from '../lib';
import { BOARD_AGENT_FIELDS } from './_fields';
import { assertBackendConnected, paginate, resolveFieldsList, withRetry, withTimeout } from './utils';

export const listBoardAgents: ToolConfig = {
  description:
    'List agents in the workspace with access to board-manager or board-runner apps. Returns: { agents: [{ agentId, name, fullName, role, avatarUrl, capabilities }], nextCursor? }. Paginated: default 50, max 200.',
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'Workspace (optional, defaults to execution)' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Custom subset of fields',
      },
      includeRaw: { type: 'boolean', description: 'Return full agent documents' },
      limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
    },
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const workspaceId = (args?.workspaceId as string) || WORKSPACE_ID;
    if (!workspaceId) throw new Error('workspaceId is required');

    const result = await withRetry(
      () =>
        withTimeout(
          wsClient.queryConversations<any>('list_board_agents', { workspaceId }),
          15_000,
          'list_board_agents',
        ),
      { retries: 2, delayMs: 500, label: 'list_board_agents' },
    );

    const { items, nextCursor } = paginate(
      (result.agents ?? []) as Record<string, unknown>[],
      args?.limit as number | undefined,
      args?.cursor as string | undefined,
    );
    const agents = resolveFieldsList(items, {
      includeRaw: args?.includeRaw === true,
      fields: args?.fields as string[] | undefined,
      defaultFields: BOARD_AGENT_FIELDS,
    });

    return { agents, ...(nextCursor ? { nextCursor } : {}) };
  },
};
