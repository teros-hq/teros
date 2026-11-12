import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, markdownToHtmlFragment, requireId } from '../lib'
import type { GraphSecrets } from '../lib'

const POSITIONS = ['after', 'before'] as const

export const appendToPage: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Add content to an existing OneNote page without removing anything. Appends to the end of the page by default; pass a target element id from get-page-content (includeIDs: true) to add next to a specific element.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Page id, as returned by list-pages or search-pages.',
      },
      content: {
        type: 'string',
        description: 'Content to add, in markdown unless contentFormat says otherwise.',
      },
      contentFormat: {
        type: 'string',
        enum: ['markdown', 'html'],
        description: 'Format of `content`. Defaults to markdown.',
      },
      target: {
        type: 'string',
        description:
          'Where to add the content: "body" (default), or a data-id from get-page-content with includeIDs: true.',
      },
      position: {
        type: 'string',
        enum: ['after', 'before'],
        description: 'Whether the content goes after (default) or before the target.',
      },
    },
    required: ['pageId', 'content'],
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
    if (typeof a.content !== 'string' || a.content.trim() === '') {
      throw new Error('Specify content — the text or markup to add to the page.')
    }

    const target = typeof a.target === 'string' && a.target.trim() ? a.target.trim() : 'body'
    const position =
      typeof a.position === 'string' && (POSITIONS as readonly string[]).includes(a.position)
        ? a.position
        : 'after'
    const format = a.contentFormat === 'html' ? 'html' : 'markdown'
    const content = await markdownToHtmlFragment(a.content, format)

    await graphRequest('PATCH', `/me/onenote/pages/${page.encoded}/content`, [
      { target, action: 'append', position, content },
    ])

    return { success: true, account: email, pageId: page.id, target, position }
  },
}
