import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, rangeRef } from '../lib'
import type { GraphSecrets } from '../lib'

const RANGE_SELECT = 'address,values,text,formulas,numberFormat,rowCount,columnCount'

export const readRange: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Read a range of cells from a worksheet. Returns raw values, display text, and the underlying formulas.',
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
        description: 'Range in A1 notation, e.g. "A1:C10" or "B2".',
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
    const range = await graphRequest<Record<string, any>>(
      'GET',
      `${rangeRef(a)}?$select=${RANGE_SELECT}`,
    )

    return {
      account: email,
      address: range.address,
      rowCount: range.rowCount,
      columnCount: range.columnCount,
      values: range.values,
      text: range.text,
      formulas: range.formulas,
      numberFormat: range.numberFormat,
    }
  },
}
