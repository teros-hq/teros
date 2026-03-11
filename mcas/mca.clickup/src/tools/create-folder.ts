import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest } from '../lib';

export const createFolder: ToolConfig = {
  description: 'Create a new folder in a ClickUp space.',
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string', description: 'The space ID where the folder will be created' },
      name: { type: 'string', description: 'Name of the new folder' },
    },
    required: ['spaceId', 'name'],
  },
  handler: async (args, context) => {
    const { spaceId, name } = args as { spaceId: string; name: string };
    const data = await clickupRequest(context, `/space/${spaceId}/folder`, {
      method: 'POST',
      body: { name },
    }) as any;
    return {
      id: data.id,
      name: data.name,
      spaceId: data.space?.id,
      orderIndex: data.orderindex,
    };
  },
};
