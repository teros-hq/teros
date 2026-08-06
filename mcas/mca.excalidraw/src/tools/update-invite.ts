import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const updateInvite: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update an existing Excalidraw Plus workspace invite (e.g. change the assigned role).',
  parameters: {
    type: 'object',
    properties: {
      inviteId: {
        type: 'string',
        description: 'The invite ID to update.',
      },
      role: {
        type: 'string',
        description: 'New role to assign to the invitee.',
      },
    },
    required: ['inviteId', 'role'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.updateInvite(args.inviteId as string, { role: args.role as string })
  },
}
