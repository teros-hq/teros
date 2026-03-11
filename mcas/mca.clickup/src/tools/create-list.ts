import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest } from '../lib';

export const createList: ToolConfig = {
  description: 'Create a new list inside a ClickUp folder.',
  parameters: {
    type: 'object',
    properties: {
      folderId: { type: 'string', description: 'The folder ID where the list will be created' },
      name: { type: 'string', description: 'Name of the new list' },
      content: { type: 'string', description: 'Description/content of the list (optional)' },
    },
    required: ['folderId', 'name'],
  },
  handler: async (args, context) => {
    const { folderId, name, content } = args as { folderId: string; name: string; content?: string };
    const body: Record<string, any> = { name };
    if (content) body.content = content;
    const data = await clickupRequest(context, `/folder/${folderId}/list`, {
      method: 'POST',
      body,
    }) as any;
    return {
      id: data.id,
      name: data.name,
      folderId: data.folder?.id,
      folderName: data.folder?.name,
      spaceId: data.space?.id,
    };
  },
};
