import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { AGENT_PROJECT_RELATIONSHIP_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const setAgentPlay: ToolConfig = {
  description:
    'Toggle autoplay for an agent on a project. When enabled=true the agent auto-picks eligible To Do tasks up to its slot limit. Requires slots≥1 (use set-agent-slots first). Disabling does NOT cancel tasks already running. Returns: { relationship: { agentId, projectId, slots, playEnabled } }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental' },
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID' },
      agentId: { type: 'string', description: 'Agent ID' },
      enabled: { type: 'boolean', description: 'true = activate autoplay, false = deactivate' },
      includeRaw: { type: 'boolean', description: 'Return full relationship document' },
    },
    required: ['projectId', 'agentId', 'enabled'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const projectId = args?.projectId as string;
    const agentId = args?.agentId as string;
    const enabled = args?.enabled as boolean;

    if (!projectId) throw new Error('projectId is required');
    if (!agentId) throw new Error('agentId is required');
    if (enabled === undefined || enabled === null) throw new Error('enabled is required');

    const result = await withTimeout(
      wsClient.queryConversations<any>('set_agent_play', {
        projectId,
        agentId,
        enabled,
      }),
      15_000,
      'set_agent_play',
    );

    const relationship = resolveFields(result.relationship ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: AGENT_PROJECT_RELATIONSHIP_FIELDS,
    });
    return { relationship };
  },
};
