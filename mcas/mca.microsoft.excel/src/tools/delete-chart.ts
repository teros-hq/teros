import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, worksheetRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const deleteChart: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Delete a chart from a worksheet by its name or id. Use list-charts first to find the chart name.',
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
      chart: {
        type: 'string',
        description: 'Chart name or id, e.g. "Chart 1". Pass the literal name, not a pre-encoded one.',
      },
    },
    required: ['worksheet', 'chart'],
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
    const chartName = encodeURIComponent(a.chart as string)

    await graphRequest('DELETE', `${worksheetRef(a)}/charts/${chartName}`)

    return {
      success: true,
      account: email,
      worksheet: a.worksheet as string,
      chart: a.chart as string,
      action: 'deleted',
    }
  },
}
