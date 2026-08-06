import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const updateCollection: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update the metadata of an existing Excalidraw collection (e.g. rename it).',
  parameters: {
    type: 'object',
    properties: {
      collectionId: {
        type: 'string',
        description: 'The collection ID to update.',
      },
      name: {
        type: 'string',
        description: 'New name for the collection.',
      },
    },
    required: ['collectionId', 'name'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.updateCollection(args.collectionId as string, { name: args.name as string })
  },
}
