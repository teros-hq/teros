import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, rangeRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const deleteRowsOrColumns: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Delete rows or columns at a range, shifting the surviving cells to close the gap. This cannot be undone by this app.',
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
          'What to delete, in A1 notation. "5:6" deletes rows 5 and 6; "B:B" deletes column B.',
      },
      direction: {
        type: 'string',
        description: 'What to delete: "rows" or "columns".',
      },
    },
    required: ['worksheet', 'address', 'direction'],
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
    const direction = a.direction as string

    if (direction !== 'rows' && direction !== 'columns') {
      throw new Error('direction must be "rows" or "columns".')
    }

    const shift = direction === 'rows' ? 'Up' : 'Left'
    await graphRequest('POST', `${rangeRef(a)}/delete`, { shift })

    return { success: true, account: email, address: a.address as string, direction, shift }
  },
}
