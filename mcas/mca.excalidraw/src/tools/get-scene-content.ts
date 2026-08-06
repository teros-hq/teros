import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const getSceneContent: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Retrieve the complete drawing content of an Excalidraw scene: all elements (shapes, text, arrows, etc.), app state, and embedded files.',
  parameters: {
    type: 'object',
    properties: {
      sceneId: {
        type: 'string',
        description: 'The scene ID whose content to retrieve.',
      },
    },
    required: ['sceneId'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.getSceneContent(args.sceneId as string)
  },
}
