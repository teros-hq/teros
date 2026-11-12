import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatWorksheet, workbookRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const listWorksheets: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List every worksheet in an Excel workbook, with its position and visibility.',
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
    const response = await graphRequest<{ value?: any[] }>('GET', `${workbookRef(a)}/worksheets`)
    const worksheets = (response.value || []).map((ws) => formatWorksheet(ws))

    return { account: email, count: worksheets.length, worksheets }
  },
}
