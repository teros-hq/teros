import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const createCollectionScene: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new scene directly inside a specific Excalidraw collection. Equivalent to create-scene but scoped to the collection.',
  parameters: {
    type: 'object',
    properties: {
      collectionId: {
        type: 'string',
        description: 'The collection ID to create the scene in.',
      },
      name: {
        type: 'string',
        description: 'Name for the new scene.',
      },
      pinned: {
        type: 'boolean',
        description: 'Whether to pin the scene (default: false).',
        default: false,
      },
    },
    required: ['collectionId', 'name'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.createCollectionScene(args.collectionId as string, {
      name: args.name as string,
      pinned: (args.pinned as boolean | undefined) ?? false,
    })
  },
}
