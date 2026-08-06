import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const getScene: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get detailed metadata for a specific Excalidraw scene by its ID, including links and sharing settings.',
  parameters: {
    type: 'object',
    properties: {
      sceneId: {
        type: 'string',
        description: 'The scene ID to retrieve.',
      },
    },
    required: ['sceneId'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.getScene(args.sceneId as string)
  },
}
