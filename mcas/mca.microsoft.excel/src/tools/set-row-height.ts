import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, rangeRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const setRowHeight: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Set the height of one or more rows, or auto-fit them to their contents. Pass a row range like "1:10" or a single row like "1" as the address. Omit height to auto-fit the rows to their content.',
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
          'Row range in A1 notation, e.g. "1:10" for rows 1 through 10, or "1" for a single row. Use the row numbers only — no column letters.',
      },
      height: {
        type: 'number',
        description:
          'Row height in points. Omit to auto-fit the rows to their content.',
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

    if (typeof a.height === 'number') {
      await graphRequest('PATCH', `${base}/format`, { rowHeight: a.height })
      return {
        success: true,
        account: email,
        address: a.address as string,
        action: 'setHeight',
        height: a.height,
      }
    }

    // Auto-fit when no height is specified
    await graphRequest('POST', `${base}/format/autofitRows`)
    return {
      success: true,
      account: email,
      address: a.address as string,
      action: 'autoFit',
    }
  },
}
