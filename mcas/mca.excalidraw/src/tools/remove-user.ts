import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const removeUser: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Remove a user from the Excalidraw Plus workspace. This revokes their access.',
  parameters: {
    type: 'object',
    properties: {
      userId: {
        type: 'string',
        description: 'The user ID to remove from the workspace.',
      },
    },
    required: ['userId'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    await client.removeUser(args.userId as string)
    return { success: true, userId: args.userId, message: 'User removed from workspace.' }
  },
}
