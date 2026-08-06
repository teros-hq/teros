import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const getCollection: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get detailed information about a specific Excalidraw collection by its ID.',
  parameters: {
    type: 'object',
    properties: {
      collectionId: {
        type: 'string',
        description: 'The collection ID to retrieve.',
      },
    },
    required: ['collectionId'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.getCollection(args.collectionId as string)
  },
}
