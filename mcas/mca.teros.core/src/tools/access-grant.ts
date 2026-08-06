import type { ToolConfig } from '@teros/mca-sdk';
import { validateAgentId } from './utils';

export const accessGrant: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Grant an agent access to an app.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent to grant access to',
      },
      appId: {
        type: 'string',
        description: 'The app to grant access to',
      },
    },
    required: ['agentId', 'appId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    await validateAgentId(agentId, context);
    return context.accessGrant(agentId, args.appId as string);
  },
};
