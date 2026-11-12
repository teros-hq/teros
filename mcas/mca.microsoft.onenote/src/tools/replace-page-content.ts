import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, escapeHtml, markdownToHtmlFragment, requireId } from '../lib'
import type { GraphSecrets } from '../lib'

export const replacePageContent: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Replace the content of a OneNote page, or just its title. This overwrites what was there and cannot be undone — use append-to-page to add without removing.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Page id, as returned by list-pages or search-pages.',
      },
      content: {
        type: 'string',
        description:
          'Replacement content, in markdown unless contentFormat says otherwise. When target is "title", this is plain text.',
      },
      contentFormat: {
        type: 'string',
        enum: ['markdown', 'html'],
        description: 'Format of `content`. Defaults to markdown. Ignored when target is "title".',
      },
      target: {
        type: 'string',
        description:
          'What to replace: "body" (default), "title", or a data-id from get-page-content with includeIDs: true.',
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
      throw new Error(
        'Specify content — replace-page-content overwrites the target and cannot blank it.',
      )
    }

    const target = typeof a.target === 'string' && a.target.trim() ? a.target.trim() : 'body'
    const format = a.contentFormat === 'html' ? 'html' : 'markdown'

    const content =
      target === 'title'
        ? escapeHtml(a.content.trim())
        : await markdownToHtmlFragment(a.content, format)

    await graphRequest('PATCH', `/me/onenote/pages/${page.encoded}/content`, [
      { target, action: 'replace', content },
    ])

    return { success: true, account: email, pageId: page.id, target, replaced: true }
  },
}
