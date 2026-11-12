import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, worksheetRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const listCharts: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List all charts in a worksheet, with their name, type, and source data range.',
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
    const result = await graphRequest<Record<string, any>>(
      'GET',
      `${worksheetRef(a)}/charts`,
    )

    const charts = (result?.value ?? []) as any[]
    return {
      success: true,
      account: email,
      worksheet: a.worksheet as string,
      count: charts.length,
      charts: charts.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.chartType,
        height: c.height,
        width: c.width,
        top: c.top,
        left: c.left,
      })),
    }
  },
}
