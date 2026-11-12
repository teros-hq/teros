import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, rangeRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const addBorders: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Apply borders to a range. Each border specifies a side (EdgeTop, EdgeBottom, EdgeLeft, EdgeRight, InsideHorizontal, InsideVertical), a style (None, Continuous, Dash, DashDot, DashDotDot, Dotted, Double, SlantDashDot), and an optional colour as a hex string.',
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
      borders: {
        type: 'array',
        description:
          'Array of border definitions. Each entry is { side, style, color? }. side: EdgeTop, EdgeBottom, EdgeLeft, EdgeRight, InsideHorizontal, InsideVertical. style: None, Continuous, Dash, DashDot, DashDotDot, Dotted, Double, SlantDashDot. color: hex string like "#000000".',
        items: {
          type: 'object',
          properties: {
            side: { type: 'string', description: 'Border side index' },
            style: { type: 'string', description: 'Line style' },
            color: { type: 'string', description: 'Hex colour, e.g. "#000000"' },
          },
        },
      },
    },
    required: ['worksheet', 'address', 'borders'],
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
    const borders = a.borders as Array<{ side: string; style: string; color?: string }>

    if (!Array.isArray(borders) || borders.length === 0) {
      throw new Error('Specify at least one border in the borders array.')
    }

    const applied: Array<{ side: string; style: string }> = []

    for (const border of borders) {
      if (!border.side || !border.style) {
        throw new Error('Each border must have both side and style.')
      }
      const body: Record<string, unknown> = { style: border.style }
      if (border.color) body.color = border.color

      const sideEncoded = encodeURIComponent(border.side)
      await graphRequest('PATCH', `${base}/format/borders/${sideEncoded}`, body)
      applied.push({ side: border.side, style: border.style })
    }

    return {
      success: true,
      account: email,
      address: a.address as string,
      applied,
    }
  },
}
