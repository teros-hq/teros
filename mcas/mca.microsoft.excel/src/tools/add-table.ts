import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatTable, worksheetRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const addTable: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Turn a range of cells into an Excel table, so it can be appended to, sorted and filtered as a unit.',
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
        description: 'Range to convert, in A1 notation, e.g. "A1:C10".',
      },
      hasHeaders: {
        type: 'boolean',
        description: 'Whether the first row of the range holds column headers (default: true).',
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
    const table = await graphRequest<Record<string, unknown>>(
      'POST',
      `${worksheetRef(a)}/tables/add`,
      {
        address: a.address as string,
        hasHeaders: a.hasHeaders !== false,
      },
    )

    return { success: true, account: email, table: formatTable(table) }
  },
}
