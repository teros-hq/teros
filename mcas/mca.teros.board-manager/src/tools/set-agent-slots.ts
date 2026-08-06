import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { AGENT_PROJECT_RELATIONSHIP_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const setAgentSlots: ToolConfig = {
  description:
    'Configure parallel execution slots for an agent in a project. slots=0 disables autoplay (also auto-disables playEnabled if it was on). slots≥1 enables the play button. Returns: { relationship: { agentId, projectId, slots, playEnabled, activeSlots } }. Use set-agent-play to toggle autoplay after setting slots.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental' },
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID' },
      agentId: { type: 'string', description: 'Agent ID' },
      slots: {
        type: 'number',
        description: 'Parallel execution slots (0 = disabled, ≥1 = available)',
      },
      includeRaw: { type: 'boolean', description: 'Return full relationship document' },
    },
    required: ['projectId', 'agentId', 'slots'],
  },
  handler: async (args) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const projectId = args?.projectId as string;
    const agentId = args?.agentId as string;
    const slots = args?.slots as number;

    if (!projectId) throw new Error('projectId is required');
    if (!agentId) throw new Error('agentId is required');
    if (slots === undefined || slots === null) throw new Error('slots is required');
    if (!Number.isFinite(slots) || slots < 0) throw new Error('slots must be a non-negative number');

    const result = await withTimeout(
      wsClient.queryConversations<any>('set_agent_slots', {
        projectId,
        agentId,
        slots,
      }),
      15_000,
      'set_agent_slots',
    );

    const relationship = resolveFields(result.relationship ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: AGENT_PROJECT_RELATIONSHIP_FIELDS,
    });
    return { relationship };
  },
};
