import type { ToolConfig } from '@teros/mca-sdk'
import { buildGraphError, createGraphClient, pollOperation, requireId } from '../lib'
import type { GraphSecrets } from '../lib'

function pageIdFromResourceLocation(resourceLocation?: string): string | null {
  if (!resourceLocation) return null
  const match = resourceLocation.match(/\/pages\/([^/?]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export const copyPageToSection: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Copy a OneNote page into another section, including across notebooks. Waits for the copy to finish and returns the new page id.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Id of the page to copy, from list-pages or search-pages.',
      },
      destinationSectionId: {
        type: 'string',
        description: 'Id of the section to copy the page into, from list-sections.',
      },
    },
    required: ['pageId', 'destinationSectionId'],
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
    const page = requireId(a, ['pageId'], 'the page to copy, from list-pages')
    const destination = requireId(
      a,
      ['destinationSectionId'],
      'the section to copy the page into, from list-sections',
    )

    const response = await graphRequest<Response>(
      'POST',
      `/me/onenote/pages/${page.encoded}/copyToSection`,
      { id: destination.id },
      { responseType: 'raw' },
    )

    if (!response.ok) throw await buildGraphError(response)

    const operationUrl = response.headers.get('location')
    if (!operationUrl) {
      return {
        success: true,
        account: email,
        pageId: page.id,
        destinationSectionId: destination.id,
        status: 'Accepted',
        newPageId: null,
        note: 'OneNote accepted the copy but returned no operation URL, so its completion was not confirmed.',
      }
    }

    if (!operationUrl.startsWith('https://graph.microsoft.com/')) {
      throw new Error(
        `OneNote returned an unexpected operation URL host; refusing to send credentials to it: ${operationUrl}`,
      )
    }

    const operation = await pollOperation(graphRequest, operationUrl)

    return {
      success: true,
      account: email,
      pageId: page.id,
      destinationSectionId: destination.id,
      status: operation.status ?? 'Completed',
      newPageId: pageIdFromResourceLocation(operation.resourceLocation),
    }
  },
}
