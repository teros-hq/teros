import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, worksheetRef } from '../lib'
import type { GraphSecrets } from '../lib'

const RANGE_SELECT = 'address,values,text,formulas,rowCount,columnCount'

export const readUsedRange: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Read every populated cell on a worksheet without knowing its extent in advance. Use this to survey a sheet before reading specific ranges.',
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
      valuesOnly: {
        type: 'boolean',
        description:
          'When true, ignore cells that carry only formatting, so the range covers just cells with values.',
      },
    },
    required: ['worksheet'],
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
    const used = a.valuesOnly === true ? 'usedRange(valuesOnly=true)' : 'usedRange'

    const range = await graphRequest<Record<string, any>>(
      'GET',
      `${worksheetRef(a)}/${used}?$select=${RANGE_SELECT}`,
    )

    return {
      account: email,
      address: range.address,
      rowCount: range.rowCount,
      columnCount: range.columnCount,
      values: range.values,
      text: range.text,
      formulas: range.formulas,
    }
  },
}
