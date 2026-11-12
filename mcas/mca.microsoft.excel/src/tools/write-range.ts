import type { ToolConfig } from '@teros/mca-sdk'
import { assertGrid, createGraphClient, expandAddress, rangeRef, worksheetRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const writeRange: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Write cells into a worksheet range. Writes literal values by default; set formulas:true to write formula strings such as "=A1*B1". Pass a single cell like "A1" as the address and the range auto-expands to match the values array — no need to calculate the exact range dimensions. Set append:true to write at the first empty row after the used range, ignoring address. This app does not manage workbook sessions: each call runs as its own implicit session and there is no batching, so prefer one write over a wide range to many small ones.',
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
      address: {
        type: 'string',
        description:
          'Range in A1 notation, e.g. "A1:C10". A single cell like "A1" auto-expands to match the values array. Ignored when append is true.',
      },
      values: {
        type: 'array',
        description:
          'Rows of cells, e.g. [["Item","Cost"],["Widget",9.5]]. Every row must be the same length.',
        items: { type: 'array' },
      },
      formulas: {
        type: 'boolean',
        description:
          'When true, the payload is written as formulas rather than literal values (default: false).',
      },
      append: {
        type: 'boolean',
        description:
          'When true, write at the first empty row after the used range. The address parameter is ignored (only the worksheet is used). Useful for building a sheet incrementally without tracking row offsets.',
      },
    },
    required: ['worksheet', 'values'],
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
    assertGrid(a.values)

    const grid = a.values as unknown[][]
    const rows = grid.length
    const cols = grid[0].length
    const asFormulas = a.formulas === true
    const body = asFormulas ? { formulas: a.values } : { values: a.values }

    let address: string

    if (a.append === true) {
      // Fetch the used range to find the next free row
      const used = await graphRequest<Record<string, any>>('GET', `${worksheetRef(a)}/usedRange`)
      const nextRow = (used?.rowCount ?? 0) + 1 // 1-based
      const startCell = `A${nextRow}`
      address = expandAddress(startCell, rows, cols)
    } else {
      if (!a.address) {
        throw new Error('Specify address in A1 notation (e.g. "A1" or "A1:C10"), or set append:true.')
      }
      address = expandAddress(a.address as string, rows, cols)
    }

    try {
      const range = await graphRequest<Record<string, any>>(
        'PATCH',
        rangeRef({ ...a, address }),
        body,
      )

      return {
        success: true,
        account: email,
        wrote: asFormulas ? 'formulas' : 'values',
        address: range?.address ?? address,
        rowCount: range?.rowCount ?? rows,
        columnCount: range?.columnCount ?? cols,
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('InvalidArgument')) {
        throw new Error(
          `Range ${address} expects ${rows} rows × ${cols} columns, ` +
            `but the values array has a different shape. ` +
            `Tip: pass a single cell like "A1" and the range will auto-expand to match your data.`,
        )
      }
      throw error
    }
  },
}
