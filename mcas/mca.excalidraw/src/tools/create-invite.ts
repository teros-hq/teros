import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const createInvite: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Invite a user to the Excalidraw Plus workspace by email. Optionally specify their role.',
  parameters: {
    type: 'object',
    properties: {
      email: {
        type: 'string',
        description: 'Email address of the person to invite.',
      },
      role: {
        type: 'string',
        description: 'Role to assign (e.g. "admin", "member"). Defaults to workspace default.',
      },
    },
    required: ['email'],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.createInvite({
      email: args.email as string,
      role: args.role as string | undefined,
    })
  },
}
