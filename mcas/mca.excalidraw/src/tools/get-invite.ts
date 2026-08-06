import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const getInvite: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get details for a specific Excalidraw Plus workspace invite by its ID.',
  parameters: {
    type: 'object',
    properties: {
      inviteId: {
        type: 'string',
        description: 'The invite ID to retrieve.',
      },
    },
    required: ['inviteId'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.getInvite(args.inviteId as string)
  },
}
