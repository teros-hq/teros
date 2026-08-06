import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const listLogs: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Retrieve workspace audit logs from Excalidraw Plus. Useful for tracking activity, changes, and access history.',
  parameters: {
    type: 'object',
    properties: {
      cursor: {
        type: 'string',
        description: 'Pagination cursor from a previous response.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of log entries to return (default: 50).',
        default: 50,
      },
    },
    required: [],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.listLogs(
      args.cursor as string | undefined,
      args.limit as number | undefined,
    )
  },
}
