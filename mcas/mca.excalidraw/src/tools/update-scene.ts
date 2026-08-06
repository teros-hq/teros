import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const updateScene: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update the metadata of an existing Excalidraw scene (name, pinned status, collection assignment).',
  parameters: {
    type: 'object',
    properties: {
      sceneId: {
        type: 'string',
        description: 'The scene ID to update.',
      },
      name: {
        type: 'string',
        description: 'New name for the scene.',
      },
      pinned: {
        type: 'boolean',
        description: 'Whether to pin the scene.',
      },
      collectionId: {
        type: 'string',
        description: 'Move the scene to a different collection by providing its ID.',
      },
    },
    required: ['sceneId'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    const payload: { name?: string; pinned?: boolean; collectionId?: string } = {}
    if (args.name !== undefined) payload.name = args.name as string
    if (args.pinned !== undefined) payload.pinned = args.pinned as boolean
    if (args.collectionId !== undefined) payload.collectionId = args.collectionId as string
    return client.updateScene(args.sceneId as string, payload)
  },
}
