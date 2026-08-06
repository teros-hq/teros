import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const createScene: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new empty Excalidraw scene with specified metadata. Optionally assign it to a collection and pin it. Returns the created scene with its ID and sharing links.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name for the new scene.',
      },
      collectionId: {
        type: 'string',
        description: 'ID of the collection to place the scene in.',
      },
      pinned: {
        type: 'boolean',
        description: 'Whether to pin the scene (default: false).',
        default: false,
      },
    },
    required: ['name', 'collectionId'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.createScene({
      name: args.name as string,
      collectionId: args.collectionId as string,
      pinned: (args.pinned as boolean | undefined) ?? false,
    })
  },
}
