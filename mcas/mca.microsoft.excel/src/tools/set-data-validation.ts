import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, rangeRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const setDataValidation: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Set data validation rules on a range — dropdown lists, number constraints, date ranges, text length limits, or custom formulas. Use clear:true to remove all data validation from the range.',
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
      address: { type: 'string', description: 'Range in A1 notation, e.g. "A1:A10".' },
      clear: {
        type: 'boolean',
        description: 'When true, remove all data validation from the range.',
      },
      validationType: {
        type: 'string',
        description:
          'Type of validation: "List" (dropdown), "WholeNumber", "Decimal", "Date", "TextLength", "Custom".',
      },
      operator: {
        type: 'string',
        description:
          'Comparison operator: "GreaterThan", "GreaterThanOrEqual", "LessThan", "LessThanOrEqual", "Between", "NotBetween", "EqualTo", "NotEqualTo". Required for all types except List and Custom.',
      },
      formula1: {
        type: 'string',
        description:
          'First formula or value. For List, a comma-separated list like "Yes,No,Maybe" or a range reference like "=Sheet1!A1:A10". For other types, the comparison value.',
      },
      formula2: {
        type: 'string',
        description: 'Second formula for "Between" / "NotBetween" operators.',
      },
      prompt: {
        type: 'string',
        description: 'Input prompt shown when the cell is selected.',
      },
      errorAlert: {
        type: 'string',
        description: 'Error message shown when invalid data is entered.',
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

    if (a.clear === true) {
      await graphRequest('POST', `${base}/dataValidation/clear`)
      return { success: true, account: email, address: a.address as string, action: 'cleared' }
    }

    const validationType = a.validationType as string
    if (!validationType) {
      throw new Error('Specify validationType (List, WholeNumber, Decimal, Date, TextLength, Custom), or set clear:true.')
    }

    const body: Record<string, unknown> = { type: validationType }

    if (validationType !== 'List' && validationType !== 'Custom') {
      if (!a.operator) {
        throw new Error(`${validationType} validation requires an operator.`)
      }
      body.operator = a.operator
    }

    if (a.formula1) body.formula1 = a.formula1
    if (a.formula2) body.formula2 = a.formula2

    if (a.prompt) {
      body.prompt = { title: 'Input', message: a.prompt }
    }
    if (a.errorAlert) {
      body.errorAlert = { style: 'Stop', title: 'Invalid', message: a.errorAlert }
    }

    await graphRequest('PATCH', `${base}/dataValidation`, body)

    return {
      success: true,
      account: email,
      address: a.address as string,
      action: 'set',
      validationType,
    }
  },
}
