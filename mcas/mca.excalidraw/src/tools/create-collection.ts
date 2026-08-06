import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const createCollection: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new collection (folder) in the Excalidraw Plus workspace to group related scenes.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name for the new collection.',
      },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.createCollection({ name: args.name as string })
  },
}
