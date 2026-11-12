import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatPage, PAGE_EXPAND, requireId } from '../lib'
import type { GraphSecrets } from '../lib'

export const getPage: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get one OneNote page by id: its title, timestamps, position, and parent section. Use get-page-content to read the page body.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Page id, as returned by list-pages or search-pages.',
      },
    },
    required: ['pageId'],
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
    const page = requireId(a, ['pageId'], 'the page id from list-pages or search-pages')

    const found = await graphRequest<Record<string, any>>(
      'GET',
      `/me/onenote/pages/${page.encoded}?$expand=${PAGE_EXPAND}`,
    )

    return { account: email, page: formatPage(found) }
  },
}
