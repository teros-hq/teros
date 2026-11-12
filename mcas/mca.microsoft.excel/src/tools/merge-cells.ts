import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, rangeRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const mergeCells: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Merge a range of cells into a single cell. Use unmerge:true to split a merged cell back into individual cells. Orientation controls how cells are combined: "all" (default) merges everything into one cell, "across" merges each row separately, "down" merges each column separately.',
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
      orientation: {
        type: 'string',
        description:
          'How to merge: "all" (default, everything into one cell), "across" (each row merged separately), or "down" (each column merged separately). Ignored when unmerge is true.',
      },
      unmerge: {
        type: 'boolean',
        description:
          'When true, unmerge the range instead of merging it. The orientation parameter is ignored.',
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

    if (a.unmerge === true) {
      await graphRequest('POST', `${base}/unmerge`)
      return { success: true, account: email, address: a.address as string, action: 'unmerged' }
    }

    const orientation = (a.orientation as string) || 'all'
    await graphRequest('POST', `${base}/merge`, { orientation })

    return {
      success: true,
      account: email,
      address: a.address as string,
      action: 'merged',
      orientation,
    }
  },
}
