import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatWorksheet, worksheetRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const renameWorksheet: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Rename a worksheet, or change its position or visibility.',
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
      worksheet: { type: 'string', description: 'Current worksheet name or id' },
      newName: { type: 'string', description: 'New name for the worksheet' },
      position: { type: 'number', description: 'Optional zero-based tab position' },
      visibility: {
        type: 'string',
        description: 'Optional visibility: "Visible", "Hidden", or "VeryHidden".',
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
    const body: Record<string, unknown> = {}
    if (a.newName) body.name = a.newName as string
    if (typeof a.position === 'number') body.position = a.position
    if (a.visibility) body.visibility = a.visibility as string

    if (Object.keys(body).length === 0) {
      throw new Error('Specify at least one of newName, position, or visibility.')
    }

    const worksheet = await graphRequest<Record<string, unknown>>('PATCH', worksheetRef(a), body)

    return { success: true, account: email, worksheet: formatWorksheet(worksheet) }
  },
}
