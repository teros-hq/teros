import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, rangeRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const addConditionalFormat: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Add a conditional formatting rule to a range. Rule types: CellValue (compare cell values with operator + formula), ColorScale (3-color gradient), DataBar (in-cell data bars), IconSet (icon-based), TopBottom (top/bottom N), Custom (formula-based). Use list:true to list existing rules on the range, or deleteIndex to delete a rule by its zero-based index.',
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
      list: {
        type: 'boolean',
        description: 'When true, list all conditional formatting rules on the range instead of adding one.',
      },
      deleteIndex: {
        type: 'number',
        description: 'When set, delete the conditional formatting rule at this zero-based index instead of adding one.',
      },
      ruleType: {
        type: 'string',
        description:
          'Type of conditional formatting: "CellValue", "ColorScale", "DataBar", "IconSet", "TopBottom", "Custom".',
      },
      operator: {
        type: 'string',
        description:
          'Comparison operator for CellValue type: "GreaterThan", "GreaterThanOrEqual", "LessThan", "LessThanOrEqual", "Between", "NotBetween", "EqualTo", "NotEqualTo".',
      },
      formula: {
        type: 'string',
        description:
          'Formula or value for the rule, e.g. "0" for CellValue GreaterThan 0. For TopBottom, use a number like "10" for top 10.',
      },
      fill: {
        type: 'object',
        description: 'Fill format for the rule, e.g. { color: "#FF0000" }.',
        properties: {
          color: { type: 'string', description: 'Fill colour as hex, e.g. "#FF0000"' },
        },
      },
      font: {
        type: 'object',
        description: 'Font format for the rule, e.g. { color: "#FFFFFF", bold: true }.',
        properties: {
          color: { type: 'string', description: 'Font colour as hex' },
          bold: { type: 'boolean', description: 'Bold text' },
        },
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

    // List mode
    if (a.list === true) {
      const result = await graphRequest<Record<string, any>>('GET', `${base}/format/conditionalFormatting`)
      const rules = (result?.value ?? []) as any[]
      return {
        success: true,
        account: email,
        address: a.address as string,
        count: rules.length,
        rules: rules.map((r, i) => ({
          index: i,
          id: r.id,
          type: r.type,
          cellValue: r.cellValue,
          colorScale: r.colorScale,
          dataBar: r.dataBar,
          iconSet: r.iconSet,
          topBottom: r.topBottom,
          custom: r.custom,
        })),
      }
    }

    // Delete mode
    if (typeof a.deleteIndex === 'number') {
      const listResult = await graphRequest<Record<string, any>>('GET', `${base}/format/conditionalFormatting`)
      const rules = (listResult?.value ?? []) as any[]
      const rule = rules[a.deleteIndex]
      if (!rule) {
        throw new Error(`No conditional formatting rule at index ${a.deleteIndex}. The range has ${rules.length} rules (0–${rules.length - 1}).`)
      }
      await graphRequest('DELETE', `${base}/format/conditionalFormatting/${encodeURIComponent(rule.id)}`)
      return {
        success: true,
        account: email,
        address: a.address as string,
        action: 'deleted',
        deletedIndex: a.deleteIndex,
      }
    }

    // Add mode
    const ruleType = a.ruleType as string
    if (!ruleType) {
      throw new Error('Specify ruleType (CellValue, ColorScale, DataBar, IconSet, TopBottom, Custom), or set list:true to list rules, or deleteIndex to delete a rule.')
    }

    const body: Record<string, unknown> = {}

    switch (ruleType) {
      case 'CellValue': {
        if (!a.operator || !a.formula) {
          throw new Error('CellValue rules require operator and formula.')
        }
        body.cellValue = {
          operator: a.operator,
          formula: [a.formula as string],
        }
        break
      }
      case 'ColorScale': {
        body.colorScale = {
          threeColorScale: {
            minimum: { color: '#F8696B', type: 'Min' },
            midpoint: { color: '#FFEB84', type: 'Percentile', value: '50' },
            maximum: { color: '#63BE7B', type: 'Max' },
          },
        }
        break
      }
      case 'DataBar': {
        body.dataBar = {
          barDirection: 'LeftToRight',
          positiveFormat: { fillColor: '#63BE7B' },
          negativeFormat: { fillColor: '#F8696B' },
        }
        break
      }
      case 'IconSet': {
        body.iconSet = {
          style: 'ThreeTrafficLights1',
          reverseIconOrder: false,
          showIconOnly: false,
        }
        break
      }
      case 'TopBottom': {
        body.topBottom = {
          rank: a.formula ? `${a.formula}` : '10',
          rankType: 'Top',
        }
        break
      }
      case 'Custom': {
        if (!a.formula) {
          throw new Error('Custom rules require a formula.')
        }
        body.custom = { formula: [a.formula as string] }
        break
      }
      default:
        throw new Error(`Unknown ruleType: "${ruleType}". Use CellValue, ColorScale, DataBar, IconSet, TopBottom, or Custom.`)
    }

    // Attach format (fill/font) for rule types that support it
    const format: Record<string, unknown> = {}
    if (a.fill) format.fill = a.fill
    if (a.font) format.font = a.font
    if (Object.keys(format).length > 0) body.format = format

    const result = await graphRequest<Record<string, any>>(
      'POST',
      `${base}/format/conditionalFormatting/add`,
      body,
    )

    return {
      success: true,
      account: email,
      address: a.address as string,
      action: 'added',
      ruleType,
      ruleId: result?.id,
    }
  },
}
