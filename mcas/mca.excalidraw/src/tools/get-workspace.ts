import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const getWorkspace: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: "Retrieve the current Excalidraw Plus workspace's metadata, including name, users, and invites.",
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async (_args, context) => {
    const client = await getExcalidrawClient(context)
    return client.getWorkspace()
  },
}
