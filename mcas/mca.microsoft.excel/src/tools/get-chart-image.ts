import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, worksheetRef } from '../lib'
import type { GraphSecrets } from '../lib'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export const getChartImage: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Render a chart as a PNG image, returned base64-encoded. Use this to visually check a chart you created. Pass width and height to keep the image small — a render over 5 MB is rejected.',
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
      worksheet: { type: 'string', description: 'Worksheet name or id holding the chart' },
      chart: {
        type: 'string',
        description:
          'Chart name or id, e.g. "Chart 1". Pass the literal name, not a pre-encoded one.',
      },
      width: { type: 'number', description: 'Optional image width in pixels' },
      height: { type: 'number', description: 'Optional image height in pixels' },
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
    if (typeof a.chart !== 'string' || !a.chart.trim()) {
      throw new Error('Specify chart — its name (e.g. "Chart 1") or its id.')
    }
    const chart = encodeURIComponent(a.chart)

    const params: string[] = []
    if (typeof a.width === 'number') params.push(`width=${a.width}`)
    if (typeof a.height === 'number') params.push(`height=${a.height}`)
    const suffix = params.length > 0 ? `(${params.join(',')})` : ''

    const response = await graphRequest<{ value?: string }>(
      'GET',
      `${worksheetRef(a)}/charts/${chart}/image${suffix}`,
    )

    if (!response?.value) {
      throw new Error(
        `Chart "${a.chart}" returned no image data. Confirm the chart name with add-chart's response or list the worksheet's charts in Excel.`,
      )
    }

    const byteLength = Buffer.byteLength(response.value, 'base64')
    if (byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `Chart "${a.chart}" rendered to ${byteLength} bytes, over the ${MAX_IMAGE_BYTES}-byte limit for an inline image. Re-request it with smaller width and height values.`,
      )
    }

    return {
      account: email,
      chart: a.chart,
      mimeType: 'image/png',
      byteLength,
      base64: response.value,
    }
  },
}
