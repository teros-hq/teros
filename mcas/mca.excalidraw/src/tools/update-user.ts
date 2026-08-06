import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const updateUser: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update a workspace user in Excalidraw Plus (e.g. change their role).',
  parameters: {
    type: 'object',
    properties: {
      userId: {
        type: 'string',
        description: 'The user ID to update.',
      },
      role: {
        type: 'string',
        description: 'New role for the user (e.g. "admin", "member").',
      },
      name: {
        type: 'string',
        description: 'New display name for the user.',
      },
    },
    required: ['userId'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    const payload: { role?: string; name?: string } = {}
    if (args.role !== undefined) payload.role = args.role as string
    if (args.name !== undefined) payload.name = args.name as string
    return client.updateUser(args.userId as string, payload)
  },
}
