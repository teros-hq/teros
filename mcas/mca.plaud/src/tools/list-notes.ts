import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getPlaudClient, mapRecording } from '../lib'
import type { PlaudRecording } from '../lib'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export const listNotes: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List PLAUD voice recordings. Returns metadata for each recording ordered by creation date (most recent first).',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: `Maximum number of recordings to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
        default: DEFAULT_LIMIT,
      },
    },
    required: [],
  },
  handler: async (args, context) => {
    const limit = Math.min(
      Math.max(1, (args.limit as number | undefined) ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    )

    const client = await getPlaudClient(context)
    const raw = await client.listRecordings({ page_size: limit }) as Record<string, unknown>

    // Handle both array and wrapped response shapes
    const list: Record<string, unknown>[] = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as any).data)
        ? (raw as any).data
        : Array.isArray((raw as any).list)
          ? (raw as any).list
          : []

    const recordings: PlaudRecording[] = list
      .map((item) => mapRecording(item))
      .sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0
        return tb - ta
      })
      .slice(0, limit)

    return {
      recordings,
      total: recordings.length,
    }
  },
}
