import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const getUser: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get details for a specific user in the Excalidraw Plus workspace by their user ID.',
  parameters: {
    type: 'object',
    properties: {
      userId: {
        type: 'string',
        description: 'The user ID to retrieve.',
      },
    },
    required: ['userId'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.getUser(args.userId as string)
  },
}
