import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getGranolaClient } from '../lib'

const DEFAULT_PAGE_SIZE = 10
const MAX_PAGE_SIZE = 30

/**
 * List Granola meeting notes with optional date filters.
 *
 * The API only returns notes that have an AI summary and transcript generated.
 * Notes still processing may not appear in results.
 */
export const listNotes: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List Granola meeting notes with optional filters. Returns notes with id, title, owner, created_at, updated_at. The API only returns notes that have an AI summary and transcript generated.',
  parameters: {
    type: 'object',
    properties: {
      created_before: {
        type: 'string',
        description:
          'ISO date or datetime. Only notes created before this date are returned.',
      },
      created_after: {
        type: 'string',
        description:
          'ISO date or datetime. Only notes created after this date are returned.',
      },
      updated_after: {
        type: 'string',
        description:
          'ISO date or datetime. Only notes updated after this date are returned.',
      },
      cursor: {
        type: 'string',
        description: 'Pagination cursor from a previous response.',
      },
      page_size: {
        type: 'number',
        description: `Results per page (default: ${DEFAULT_PAGE_SIZE}, max: ${MAX_PAGE_SIZE})`,
        default: DEFAULT_PAGE_SIZE,
      },
    },
    required: [],
  },
  handler: async (args, context) => {
    const pageSize = Math.min(
      Math.max(
        1,
        (args.page_size as number | undefined) ?? DEFAULT_PAGE_SIZE,
      ),
      MAX_PAGE_SIZE,
    )

    const client = await getGranolaClient(context)
    const result = await client.listNotes({
      created_before: args.created_before as string | undefined,
      created_after: args.created_after as string | undefined,
      updated_after: args.updated_after as string | undefined,
      cursor: args.cursor as string | undefined,
      page_size: pageSize,
    })

    return {
      notes: result.notes,
      hasMore: result.hasMore,
      cursor: result.cursor,
    }
  },
}
