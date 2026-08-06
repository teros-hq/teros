import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const deleteCollection: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Soft-delete an Excalidraw collection by moving it to trash. Scenes inside the collection are not deleted.',
  parameters: {
    type: 'object',
    properties: {
      collectionId: {
        type: 'string',
        description: 'The collection ID to delete.',
      },
    },
    required: ['collectionId'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    await client.deleteCollection(args.collectionId as string)
    return { success: true, collectionId: args.collectionId, message: 'Collection moved to trash.' }
  },
}
