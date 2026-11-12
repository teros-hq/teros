import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, htmlToMarkdown, requireId } from '../lib'
import type { GraphSecrets } from '../lib'

export const getPageContent: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Read the body of a OneNote page. Returns markdown by default. Set includeIDs to get the element ids that append-to-page and replace-page-content can target — that always returns HTML, because markdown cannot carry the ids.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Page id, as returned by list-pages or search-pages.',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'html'],
        description:
          'Output format. Defaults to markdown. Forced to html when includeIDs is set.',
      },
      includeIDs: {
        type: 'boolean',
        description:
          'Include OneNote data-id attributes so individual elements can be targeted for editing. Implies format: html.',
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
    const includeIDs = a.includeIDs === true
    const requestedFormat = a.format === 'html' ? 'html' : 'markdown'

    const format = includeIDs ? 'html' : requestedFormat
    const note =
      includeIDs && requestedFormat === 'markdown'
        ? 'Returned HTML instead of markdown: includeIDs was set, and markdown cannot carry OneNote data-id attributes.'
        : undefined

    const query = includeIDs ? '?includeIDs=true' : ''
    const html = await graphRequest<string>(
      'GET',
      `/me/onenote/pages/${page.encoded}/content${query}`,
      undefined,
      { responseType: 'text' },
    )

    const content = format === 'html' ? html : htmlToMarkdown(html)

    return { account: email, pageId: page.id, format, content, ...(note ? { note } : {}) }
  },
}
