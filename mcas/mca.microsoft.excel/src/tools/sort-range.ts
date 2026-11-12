import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, rangeRef } from '../lib'
import type { GraphSecrets } from '../lib'

interface SortKey {
  column: number
  ascending?: boolean
}

export const sortRange: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Sort a range by one or more columns. Column indexes are zero-based and relative to the range, not the sheet.',
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
      address: { type: 'string', description: 'Range in A1 notation, e.g. "A1:C10".' },
      sortBy: {
        type: 'array',
        description:
          'Sort keys applied in order. Each entry is { column: <zero-based index within the range>, ascending?: boolean } — ascending defaults to true.',
        items: { type: 'object' },
      },
      hasHeaders: {
        type: 'boolean',
        description: 'When true, the first row is treated as headers and is not sorted.',
      },
      matchCase: { type: 'boolean', description: 'Case-sensitive comparison (default: false)' },
    },
    required: ['worksheet', 'address', 'sortBy'],
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
    const sortBy = a.sortBy as SortKey[] | undefined

    if (!Array.isArray(sortBy) || sortBy.length === 0) {
      throw new Error(
        'sortBy must list at least one key, e.g. [{ "column": 0, "ascending": true }].',
      )
    }

    const fields = sortBy.map((key) => {
      if (typeof key?.column !== 'number') {
        throw new Error('Each sortBy entry needs a numeric zero-based "column".')
      }
      return { key: key.column, ascending: key.ascending !== false, sortOn: 'Value' }
    })

    await graphRequest('POST', `${rangeRef(a)}/sort/apply`, {
      fields,
      hasHeaders: a.hasHeaders === true,
      matchCase: a.matchCase === true,
    })

    return { success: true, account: email, address: a.address as string, sortedBy: fields }
  },
}
