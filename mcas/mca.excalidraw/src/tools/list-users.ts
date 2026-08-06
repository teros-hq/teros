import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const listUsers: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all users in the Excalidraw Plus workspace with their roles and metadata.',
  parameters: {
    type: 'object',
    properties: {
      cursor: {
        type: 'string',
        description: 'Pagination cursor from a previous response.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of users to return (default: 50).',
        default: 50,
      },
    },
    required: [],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.listUsers(
      args.cursor as string | undefined,
      args.limit as number | undefined,
    )
  },
}
