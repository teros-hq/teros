import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const listScenes: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all Excalidraw scenes in the workspace with their metadata and links. Supports pagination via cursor.',
  parameters: {
    type: 'object',
    properties: {
      cursor: {
        type: 'string',
        description: 'Pagination cursor from a previous response to get the next page.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of scenes to return per page (default: 50).',
        default: 50,
      },
    },
    required: [],
  },
  handler: async (args, context) => {
    const client = await getExcalidrawClient(context)
    const result = await client.listScenes(
      args.cursor as string | undefined,
      args.limit as number | undefined,
    )
    return result
  },
}
