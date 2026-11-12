import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatWorksheet, workbookRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const addWorksheet: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Add a new worksheet to an Excel workbook.',
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
      name: {
        type: 'string',
        description: 'Name for the new worksheet. Excel assigns one if omitted.',
      },
    },
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
    if (a.name) body.name = a.name as string

    const worksheet = await graphRequest<Record<string, unknown>>(
      'POST',
      `${workbookRef(a)}/worksheets/add`,
      body,
    )

    return { success: true, account: email, worksheet: formatWorksheet(worksheet) }
  },
}
