import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const deleteScene: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Soft-delete an Excalidraw scene by moving it to trash. The scene can be recovered from the Excalidraw Plus UI.',
  parameters: {
    type: 'object',
    properties: {
      sceneId: {
        type: 'string',
        description: 'The scene ID to delete.',
      },
    },
    required: ['sceneId'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    await client.deleteScene(args.sceneId as string)
    return { success: true, sceneId: args.sceneId, message: 'Scene moved to trash.' }
  },
}
