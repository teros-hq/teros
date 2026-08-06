import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const listInvites: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all pending and active invites for the Excalidraw Plus workspace.',
  parameters: {
    type: 'object',
    properties: {
      cursor: {
        type: 'string',
        description: 'Pagination cursor from a previous response.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of invites to return (default: 50).',
        default: 50,
      },
    },
    required: [],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.listInvites(
      args.cursor as string | undefined,
      args.limit as number | undefined,
    )
  },
}
