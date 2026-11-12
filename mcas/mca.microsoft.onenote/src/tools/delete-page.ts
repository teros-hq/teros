import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, requireId } from '../lib'
import type { GraphSecrets } from '../lib'

export const deletePage: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Delete a OneNote page. The page goes to the notebook recycle bin, but this cannot be undone from here.',
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

    await graphRequest('DELETE', `/me/onenote/pages/${page.encoded}`)

    return { success: true, account: email, pageId: page.id, deleted: true }
  },
}
