import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const deleteInvite: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Delete a pending Excalidraw Plus workspace invite, revoking the invitation.',
  parameters: {
    type: 'object',
    properties: {
      inviteId: {
        type: 'string',
        description: 'The invite ID to delete.',
      },
    },
    required: ['inviteId'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    await client.deleteInvite(args.inviteId as string)
    return { success: true, inviteId: args.inviteId, message: 'Invite deleted.' }
  },
}
