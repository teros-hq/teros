import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const updateWorkspace: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: "Update the current Excalidraw Plus workspace's metadata (e.g. rename it).",
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'New name for the workspace.',
      },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.updateWorkspace({ name: args.name as string })
  },
}
