import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, escapeODataLiteral, formatPage, PAGE_EXPAND } from '../lib'
import type { GraphSecrets } from '../lib'

const DEFAULT_TOP = 25
const MAX_TOP = 100

function isUnsupportedQuery(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /BadRequest|InvalidRequest|ParseUri|not supported|unsupported|invalid filter|invalid query|\$search|\$filter/i.test(
    message,
  )
}

export const searchPages: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Search OneNote pages by text. Results may not be exhaustive — OneNote search coverage varies by account type, and this falls back to matching page titles when full-text search is unavailable. Use list-pages to browse a section reliably.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Text to search for. Pass the literal text, not a pre-encoded string.',
      },
      top: {
        type: 'number',
        description: `Maximum pages to return. Defaults to ${DEFAULT_TOP}, capped at ${MAX_TOP}.`,
      },
    },
    required: ['query'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GraphSecrets
    const { graphRequest, email } = await createGraphClient(
      secrets,
      context.updateUserSecrets?.bind(context),
      'OneNote',
      'Notes.ReadWrite.All',
    )

    const a = (args ?? {}) as Record<string, unknown>
    if (typeof a.query !== 'string' || a.query.trim() === '') {
      throw new Error('Specify query — the text to search OneNote pages for.')
    }
    const query = a.query.trim()

    const requested = typeof a.top === 'number' && Number.isFinite(a.top) ? a.top : DEFAULT_TOP
    const top = Math.min(Math.max(Math.trunc(requested), 1), MAX_TOP)
    const common = `$expand=${PAGE_EXPAND}&$top=${top}`

    let lastFailure = ''

    let searchResponse: { value?: any[] } | undefined
    try {
      searchResponse = await graphRequest<{ value?: any[] }>(
        'GET',
        `/me/onenote/pages?$search=${encodeURIComponent(query)}&${common}`,
      )
    } catch (error) {
      if (!isUnsupportedQuery(error)) throw error
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    if (searchResponse) {
      const pages = (searchResponse.value || []).map((p) => formatPage(p))
      return { account: email, query, searchMethod: 'search', count: pages.length, pages }
    }

    const filter = `contains(title,'${escapeODataLiteral(query)}')`
    let filterResponse: { value?: any[] } | undefined
    try {
      filterResponse = await graphRequest<{ value?: any[] }>(
        'GET',
        `/me/onenote/pages?$filter=${encodeURIComponent(filter)}&${common}`,
      )
    } catch (error) {
      if (!isUnsupportedQuery(error)) throw error
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    if (filterResponse) {
      const pages = (filterResponse.value || []).map((p) => formatPage(p))
      return { account: email, query, searchMethod: 'filter', count: pages.length, pages }
    }

    return {
      account: email,
      query,
      searchMethod: 'none',
      count: 0,
      pages: [],
      note:
        'OneNote rejected both full-text search and a title filter on this account. ' +
        `Use list-pages to browse a notebook or section instead. Last error: ${lastFailure}`,
    }
  },
}
