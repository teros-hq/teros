import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, rangeRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const setColumnWidth: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Set the width of one or more columns, or auto-fit them to their contents. Pass a column range like "A:C" or a single column like "A" as the address. Omit width to auto-fit the columns to their content.',
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
      address: {
        type: 'string',
        description:
          'Column range in A1 notation, e.g. "A:C" for columns A through C, or "A" for a single column. Use the column letters only — no row numbers.',
      },
      width: {
        type: 'number',
        description:
          'Column width in Excel units (approximately the width of one character). Omit to auto-fit the columns to their content.',
      },
    },
    required: ['worksheet', 'address'],
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

    if (typeof a.width === 'number') {
      await graphRequest('PATCH', `${base}/format`, { columnWidth: a.width })
      return {
        success: true,
        account: email,
        address: a.address as string,
        action: 'setWidth',
        width: a.width,
      }
    }

    // Auto-fit when no width is specified
    await graphRequest('POST', `${base}/format/autofitColumns`)
    return {
      success: true,
      account: email,
      address: a.address as string,
      action: 'autoFit',
    }
  },
}
