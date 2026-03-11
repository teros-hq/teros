import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest } from '../lib';

export const getFolders: ToolConfig = {
  description: 'Get all folders in a ClickUp space.',
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string', description: 'The space ID' },
      archived: { type: 'boolean', description: 'Include archived folders (default: false)' },
    },
    required: ['spaceId'],
  },
  handler: async (args, context) => {
    const { spaceId, archived = false } = args as { spaceId: string; archived?: boolean };
    const data = await clickupRequest(context, `/space/${spaceId}/folder`, {
      params: { archived: String(archived) },
    }) as { folders: any[] };
    return {
      spaceId,
      folders: data.folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        orderIndex: folder.orderindex,
        taskCount: folder.task_count,
        archived: folder.archived,
        lists: folder.lists?.map((l: any) => ({ id: l.id, name: l.name, taskCount: l.task_count })),
      })),
    };
  },
};
