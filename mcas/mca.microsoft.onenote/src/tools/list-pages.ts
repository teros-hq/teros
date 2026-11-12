import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatPage, optionalId, PAGE_EXPAND } from '../lib'
import type { GraphSecrets } from '../lib'

const DEFAULT_TOP = 50
const MAX_TOP = 100

export const listPages: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List OneNote pages, newest first. Scoped to one section when sectionId is given, otherwise across every notebook. Returns metadata only — use get-page-content to read a page.',
  parameters: {
    type: 'object',
    properties: {
      sectionId: {
        type: 'string',
        description:
          'Optional section id from list-sections. Omit to list recent pages across all notebooks.',
      },
      top: {
        type: 'number',
        description: `Maximum pages to return. Defaults to ${DEFAULT_TOP}, capped at ${MAX_TOP}.`,
      },
    },
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
    const section = optionalId(a, ['sectionId'])
    const base = section ? `/me/onenote/sections/${section.encoded}/pages` : '/me/onenote/pages'

    const requested = typeof a.top === 'number' && Number.isFinite(a.top) ? a.top : DEFAULT_TOP
    const top = Math.min(Math.max(Math.trunc(requested), 1), MAX_TOP)

    const response = await graphRequest<{ value?: any[] }>(
      'GET',
      `${base}?$expand=${PAGE_EXPAND}&$orderby=lastModifiedDateTime%20desc&$top=${top}`,
    )
    const pages = (response.value || []).map((p) => formatPage(p))

    return { account: email, sectionId: section?.id ?? null, count: pages.length, pages }
  },
}
