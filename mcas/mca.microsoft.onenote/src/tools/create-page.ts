import type { ToolConfig } from '@teros/mca-sdk'
import {
  buildMultipartPage,
  buildPageHtml,
  createGraphClient,
  formatPage,
  markdownToHtmlFragment,
  requireId,
} from '../lib'
import type { GraphSecrets } from '../lib'

export const createPage: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a OneNote page in a section. Content is markdown by default and is converted to the HTML OneNote stores.',
  parameters: {
    type: 'object',
    properties: {
      parentSectionId: {
        type: 'string',
        description:
          'Id of the section to create the page in, from list-sections. Also accepted as sectionId.',
      },
      sectionId: {
        type: 'string',
        description: 'Alias for parentSectionId.',
      },
      title: {
        type: 'string',
        description:
          "Page title. OneNote stores this as the page's <title> element — there is no separate title field.",
      },
      content: {
        type: 'string',
        description: 'Page body, in markdown unless contentFormat says otherwise.',
      },
      contentFormat: {
        type: 'string',
        enum: ['markdown', 'html'],
        description:
          'Format of `content`. Defaults to markdown. Use html to pass OneNote markup through unchanged.',
      },
    },
    required: ['parentSectionId', 'title', 'content'],
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
    const section = requireId(
      a,
      ['parentSectionId', 'sectionId'],
      'the section to create the page in, from list-sections',
    )
    if (typeof a.title !== 'string' || a.title.trim() === '') {
      throw new Error('Specify title — OneNote stores it as the page heading.')
    }
    if (typeof a.content !== 'string' || a.content.trim() === '') {
      throw new Error(
        'Specify content — the page body, in markdown unless contentFormat says otherwise.',
      )
    }
    const format = a.contentFormat === 'html' ? 'html' : 'markdown'

    const bodyHtml = await markdownToHtmlFragment(a.content, format)
    const html = buildPageHtml(a.title.trim(), bodyHtml)
    const { body, contentType } = buildMultipartPage(html)

    const created = await graphRequest<Record<string, any>>(
      'POST',
      `/me/onenote/sections/${section.encoded}/pages`,
      undefined,
      { rawBody: body, headers: { 'Content-Type': contentType } },
    )

    return {
      success: true,
      account: email,
      sectionId: section.id,
      page: formatPage(created),
    }
  },
}
