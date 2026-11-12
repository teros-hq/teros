import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, rangeRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const addHyperlink: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Add a clickable hyperlink to a cell. This writes an Excel =HYPERLINK() formula into the target cell, which is the method supported by the Microsoft Graph Excel REST API. The cell displays the friendly text and links to the URL when clicked.',
  parameters: {
    type: 'object',
    properties: {
      itemId: {
        type: 'string',
        description: 'Workbook drive item ID. Takes precedence over path.',
      },
      path: {
        type: 'string',
        description:
          'Workbook path relative to the drive root. Pass literal names, not pre-encoded ones.',
      },
      worksheet: { type: 'string', description: 'Worksheet name or id' },
      address: { type: 'string', description: 'Target cell in A1 notation, e.g. "A1".' },
      url: {
        type: 'string',
        description: 'The URL to link to, e.g. "https://example.com".',
      },
      displayText: {
        type: 'string',
        description: 'Text to display in the cell instead of the raw URL. Defaults to the URL.',
      },
    },
    required: ['worksheet', 'address', 'url'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GraphSecrets
    const { graphRequest, email } = await createGraphClient(
      secrets,
      context.updateUserSecrets?.bind(context),
      'Excel',
      'Files.ReadWrite.All',
    )

    const a = (args ?? {}) as Record<string, unknown>
    const base = rangeRef(a)
    const url = a.url as string
    const displayText = (a.displayText as string) || url

    // Build the =HYPERLINK formula — Graph supports writing formulas via PATCH
    const formula = `=HYPERLINK("${url}","${displayText}")`

    await graphRequest('PATCH', base, { formulas: [[formula]] })

    return {
      success: true,
      account: email,
      address: a.address as string,
      url,
      displayText,
    }
  },
}
