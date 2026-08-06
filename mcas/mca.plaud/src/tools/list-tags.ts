import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getPlaudClient, mapTag } from '../lib'
import type { PlaudTag } from '../lib'

export const listTags: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all tags and folders in your PLAUD library. Each tag includes its ID, name, and recording count if available.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async (_args, context) => {
    const client = await getPlaudClient(context)
    const raw = await client.listTags() as Record<string, unknown>

    const list: Record<string, unknown>[] = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as any).data)
        ? (raw as any).data
        : Array.isArray((raw as any).list)
          ? (raw as any).list
          : []

    const tags: PlaudTag[] = list.map((item) => mapTag(item))

    return { tags }
  },
}
