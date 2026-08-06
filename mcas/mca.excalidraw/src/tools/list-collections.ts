import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const listCollections: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all collections in the Excalidraw Plus workspace. Collections are folders that group related scenes together.',
  parameters: {
    type: 'object',
    properties: {
      cursor: {
        type: 'string',
        description: 'Pagination cursor from a previous response.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of collections to return (default: 50).',
        default: 50,
      },
    },
    required: [],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    return client.listCollections(
      args.cursor as string | undefined,
      args.limit as number | undefined,
    )
  },
}
