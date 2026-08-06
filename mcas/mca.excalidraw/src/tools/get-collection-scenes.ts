import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const getCollectionScenes: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all scenes that belong to a specific Excalidraw collection.',
  parameters: {
    type: 'object',
    properties: {
      collectionId: {
        type: 'string',
        description: 'The collection ID to list scenes from.',
      },
    },
    required: ['collectionId'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.getCollectionScenes(args.collectionId as string)
  },
}
