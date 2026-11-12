/**
 * Unit tests for Excel tool handlers.
 *
 * Ported from agentapps-private/test/microsoft-excel.test.ts (tool section),
 * adapted from vitest + agentapps protocol to bun:test with mocked fetch.
 *
 * Strategy: mock globalThis.fetch to intercept Graph API calls, then call
 * tool handlers directly with a fake context.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'

const realFetch = globalThis.fetch

// Track all fetch calls for assertions
let fetchCalls: Array<{ url: string; method: string; body?: string }> = []
let nextResponse: () => Response = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })

beforeAll(() => {
  globalThis.fetch = (async (url: any, init: any) => {
    fetchCalls.push({
      url: String(url),
      method: init?.method || 'GET',
      body: init?.body ? String(init.body) : undefined,
    })
    return nextResponse()
  }) as typeof fetch
})

afterEach(() => {
  fetchCalls = []
  nextResponse = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
})

afterAll(() => {
  globalThis.fetch = realFetch
})

// Fake context that provides secrets without hitting the backend
const SYSTEM_SECRETS = {
  CLIENT_ID: 'test-client-id',
  CLIENT_SECRET: 'test-client-secret',
  REDIRECT_URIS: '["http://localhost/callback"]',
}
const USER_SECRETS = {
  ACCESS_TOKEN: 'test-access-token',
  REFRESH_TOKEN: 'test-refresh-token',
  EMAIL: 'test@teros.ai',
  EXPIRY_DATE: new Date(Date.now() + 3600_000).toISOString(), // 1h in the future
}

// biome-ignore lint/suspicious/noExplicitAny: context fake
function makeContext(): any {
  return {
    getSystemSecrets: async () => SYSTEM_SECRETS,
    getUserSecrets: async () => USER_SECRETS,
    updateUserSecrets: async () => {},
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function noContentResponse() {
  return new Response(null, { status: 204 })
}

/** Sets up a sequence of responses for sequential fetch calls. */
function setResponseSequence(...responses: Response[]) {
  let i = 0
  nextResponse = () => responses[i++] || responses[responses.length - 1]
}

// Import tools after mock is set up
const {
  createWorkbook, getWorkbook, calculateWorkbook,
  listWorksheets, addWorksheet, deleteWorksheet, renameWorksheet,
  readRange, readUsedRange, writeRange, clearRange, sortRange, formatRange,
  insertRowsOrColumns, deleteRowsOrColumns,
  listTables, addTable, addTableRows,
  addChart, getChartImage, listCharts, deleteChart,
  mergeCells, setColumnWidth, setRowHeight, addBorders,
  addConditionalFormat, setDataValidation,
  addComment, addHyperlink,
  protectSheet,
} = await import('../../src/tools')

describe('Excel tool handlers', () => {
  // ===========================================================================
  // WORKBOOK
  // ===========================================================================

  describe('create-workbook', () => {
    it('uploads the empty template to the requested path', async () => {
      setResponseSequence(jsonResponse({ id: 'item1', name: 'Budget.xlsx', size: 1526, webUrl: 'https://...' }))
      const result = await createWorkbook.handler!({ name: 'Budget.xlsx' } as any, makeContext())
      expect(result.success).toBe(true)
      expect((result as any).workbook.id).toBe('item1')
      expect(fetchCalls[0].method).toBe('PUT')
      expect(fetchCalls[0].url).toContain('/me/drive/root:/Budget.xlsx:/content')
      expect(fetchCalls[0].url).toContain('conflictBehavior=fail')
    })

    it('appends .xlsx when the name omits it', async () => {
      setResponseSequence(jsonResponse({ id: 'item1', name: 'Budget.xlsx' }))
      await createWorkbook.handler!({ name: 'Budget' } as any, makeContext())
      expect(fetchCalls[0].url).toContain('/Budget.xlsx:/content')
    })

    it('fails rather than replacing an existing file by default', async () => {
      setResponseSequence(jsonResponse({ id: 'item1' }))
      await createWorkbook.handler!({ name: 'Budget.xlsx' } as any, makeContext())
      expect(fetchCalls[0].url).toContain('conflictBehavior=fail')
    })

    it('replaces only when overwrite is set', async () => {
      setResponseSequence(jsonResponse({ id: 'item1' }))
      await createWorkbook.handler!({ name: 'Budget.xlsx', overwrite: true } as any, makeContext())
      expect(fetchCalls[0].url).toContain('conflictBehavior=replace')
    })

    it('rejects a missing name with a clear error', async () => {
      expect(createWorkbook.handler!({} as any, makeContext())).rejects.toThrow(/Specify name/)
    })
  })

  describe('get-workbook', () => {
    it('returns metadata and its worksheets', async () => {
      setResponseSequence(
        jsonResponse({ id: 'item1', name: 'Budget.xlsx', size: 5000, webUrl: 'https://...', file: { mimeType: 'application/vnd.openxmlformats' }, lastModifiedDateTime: '2026-01-01' }),
        jsonResponse({ value: [{ id: 'ws1', name: 'Sheet1', position: 0, visibility: 'Visible' }] }),
      )
      const result = await getWorkbook.handler!({ path: 'Budget.xlsx' } as any, makeContext())
      expect((result as any).id).toBe('item1')
      expect((result as any).worksheetCount).toBe(1)
      expect((result as any).worksheets[0].name).toBe('Sheet1')
    })

    it('refuses a non-xlsx item with an actionable message', async () => {
      setResponseSequence(jsonResponse({ id: 'item1', name: 'data.csv', file: { mimeType: 'text/csv' } }))
      expect(getWorkbook.handler!({ itemId: 'item1' } as any, makeContext())).rejects.toThrow(/not an \.xlsx file/)
    })

    it('refuses a folder with a clear error', async () => {
      setResponseSequence(jsonResponse({ id: 'item1', name: 'Finance', file: null }))
      expect(getWorkbook.handler!({ itemId: 'item1' } as any, makeContext())).rejects.toThrow(/folder, not a workbook/)
    })
  })

  describe('calculate-workbook', () => {
    it('posts the requested calculation type', async () => {
      setResponseSequence(noContentResponse())
      const result = await calculateWorkbook.handler!({ path: 'Budget.xlsx', calculationType: 'Full' } as any, makeContext())
      expect((result as any).calculationType).toBe('Full')
      expect(fetchCalls[0].method).toBe('POST')
      expect(fetchCalls[0].url).toContain('/application/calculate')
      expect(JSON.parse(fetchCalls[0].body!).calculationType).toBe('Full')
    })

    it('defaults to Recalculate when omitted', async () => {
      setResponseSequence(noContentResponse())
      const result = await calculateWorkbook.handler!({ path: 'Budget.xlsx' } as any, makeContext())
      expect((result as any).calculationType).toBe('Recalculate')
    })
  })

  // ===========================================================================
  // WORKSHEETS
  // ===========================================================================

  describe('list-worksheets', () => {
    it('returns formatted worksheets', async () => {
      setResponseSequence(jsonResponse({ value: [{ id: 'ws1', name: 'Sheet1', position: 0, visibility: 'Visible' }, { id: 'ws2', name: 'Sheet2', position: 1, visibility: 'Visible' }] }))
      const result = await listWorksheets.handler!({ path: 'Budget.xlsx' } as any, makeContext())
      expect((result as any).count).toBe(2)
      expect((result as any).worksheets[0].name).toBe('Sheet1')
    })
  })

  describe('add-worksheet', () => {
    it('posts the requested name', async () => {
      setResponseSequence(jsonResponse({ id: 'ws1', name: 'Data', position: 1, visibility: 'Visible' }))
      const result = await addWorksheet.handler!({ path: 'Budget.xlsx', name: 'Data' } as any, makeContext())
      expect((result as any).worksheet.name).toBe('Data')
      expect(JSON.parse(fetchCalls[0].body!).name).toBe('Data')
    })
  })

  describe('delete-worksheet', () => {
    it('encodes the worksheet name in the URL', async () => {
      setResponseSequence(noContentResponse())
      await deleteWorksheet.handler!({ path: 'Budget.xlsx', worksheet: 'My Sheet' } as any, makeContext())
      expect(fetchCalls[0].method).toBe('DELETE')
      expect(fetchCalls[0].url).toContain('My%20Sheet')
    })
  })

  describe('rename-worksheet', () => {
    it('patches the name', async () => {
      setResponseSequence(jsonResponse({ id: 'ws1', name: 'Renamed', position: 0, visibility: 'Visible' }))
      const result = await renameWorksheet.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', newName: 'Renamed' } as any, makeContext())
      expect((result as any).worksheet.name).toBe('Renamed')
      expect(JSON.parse(fetchCalls[0].body!).name).toBe('Renamed')
    })

    it('rejects a call that specifies nothing to change', async () => {
      expect(renameWorksheet.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1' } as any, makeContext())).rejects.toThrow(/Specify at least one/)
    })
  })

  // ===========================================================================
  // RANGES
  // ===========================================================================

  describe('read-range', () => {
    it('returns values, text and formulas', async () => {
      setResponseSequence(jsonResponse({ address: 'A1:B2', rowCount: 2, columnCount: 2, values: [['a', 'b'], ['c', 'd']], text: [['a', 'b'], ['c', 'd']], formulas: [['a', 'b'], ['c', 'd']], numberFormat: [['General', 'General'], ['General', 'General']] }))
      const result = await readRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:B2' } as any, makeContext())
      expect((result as any).values).toEqual([['a', 'b'], ['c', 'd']])
      expect((result as any).rowCount).toBe(2)
    })
  })

  describe('read-used-range', () => {
    it('reads the whole populated area', async () => {
      setResponseSequence(jsonResponse({ address: 'A1:C10', rowCount: 10, columnCount: 3, values: [], text: [], formulas: [] }))
      const result = await readUsedRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1' } as any, makeContext())
      expect((result as any).address).toBe('A1:C10')
      expect(fetchCalls[0].url).toContain('usedRange')
    })

    it('can restrict to cells with values', async () => {
      setResponseSequence(jsonResponse({ address: 'A1:B2', rowCount: 2, columnCount: 2, values: [], text: [], formulas: [] }))
      await readUsedRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', valuesOnly: true } as any, makeContext())
      expect(fetchCalls[0].url).toContain('usedRange(valuesOnly=true)')
    })
  })

  describe('write-range', () => {
    it('patches values by default', async () => {
      setResponseSequence(jsonResponse({ address: 'A1:B2', rowCount: 2, columnCount: 2 }))
      const result = await writeRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:B2', values: [['a', 'b'], ['c', 'd']] } as any, makeContext())
      expect((result as any).wrote).toBe('values')
      expect(JSON.parse(fetchCalls[0].body!).values).toEqual([['a', 'b'], ['c', 'd']])
    })

    it('sends formulas when the flag is set', async () => {
      setResponseSequence(jsonResponse({ address: 'A1:B2', rowCount: 2, columnCount: 2 }))
      const result = await writeRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:B2', values: [['=A1*B1']], formulas: true } as any, makeContext())
      expect((result as any).wrote).toBe('formulas')
      expect(JSON.parse(fetchCalls[0].body!).formulas).toEqual([['=A1*B1']])
    })

    it('rejects a non-rectangular payload before calling Graph', async () => {
      expect(writeRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:B2', values: [['a', 'b'], ['c']] } as any, makeContext())).rejects.toThrow(/same number of cells/)
      expect(fetchCalls.length).toBe(0)
    })

    it('rejects rows of unequal length before calling Graph', async () => {
      expect(writeRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:B2', values: [['a'], ['b', 'c']] } as any, makeContext())).rejects.toThrow(/same number of cells/)
      expect(fetchCalls.length).toBe(0)
    })

    it('rejects an empty values array before calling Graph', async () => {
      expect(writeRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:B2', values: [] } as any, makeContext())).rejects.toThrow(/non-empty/)
      expect(fetchCalls.length).toBe(0)
    })

    it('auto-expands a single-cell address to match the values array', async () => {
      setResponseSequence(jsonResponse({ address: 'A1:F14', rowCount: 14, columnCount: 6 }))
      const values = Array.from({ length: 14 }, () => Array.from({ length: 6 }, (_, i) => `v${i}`))
      await writeRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1', values } as any, makeContext())
      // The PATCH URL must contain the expanded range A1:F14
      expect(fetchCalls[0].url).toContain('A1%3AF14')
    })

    it('appends after the used range when append:true', async () => {
      // 1st call: GET usedRange → rowCount 10 → next row = 11
      // 2nd call: PATCH at A11:B12 (2 rows × 2 cols)
      setResponseSequence(
        jsonResponse({ address: 'A1:J10', rowCount: 10, columnCount: 10 }),
        jsonResponse({ address: 'A11:B12', rowCount: 2, columnCount: 2 }),
      )
      const result = await writeRange.handler!({
        path: 'Budget.xlsx',
        worksheet: 'Sheet1',
        append: true,
        values: [['Jan', 50000], ['Feb', 56000]],
      } as any, makeContext())
      // First call should be GET usedRange
      expect(fetchCalls[0].method).toBe('GET')
      expect(fetchCalls[0].url).toContain('usedRange')
      // Second call should be PATCH with the expanded address starting at A11
      expect(fetchCalls[1].method).toBe('PATCH')
      expect(fetchCalls[1].url).toContain('A11%3AB12')
      expect((result as any).address).toBe('A11:B12')
    })

    it('augments InvalidArgument errors with expected vs actual dimensions', async () => {
      // Graph returns a 400 with InvalidArgument when the values shape doesn't match the range
      setResponseSequence(jsonResponse(
        { error: { code: 'InvalidArgument', message: "The number of rows or columns in the input array doesn't match the size or dimensions of the range." } },
        400,
      ))
      // Pass a range that doesn't match the values (A1:C10 = 10×3 but values is 2×2)
      // Since A1:C10 already has a colon, expandAddress won't change it
      await expect(
        writeRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10', values: [['a', 'b'], ['c', 'd']] } as any, makeContext()),
      ).rejects.toThrow(/Range A1:C10 expects 2 rows × 2 columns.*auto-expand/)
    })
  })

  describe('clear-range', () => {
    it('posts the requested applyTo', async () => {
      setResponseSequence(noContentResponse())
      const result = await clearRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10', applyTo: 'Contents' } as any, makeContext())
      expect((result as any).applyTo).toBe('Contents')
      expect(JSON.parse(fetchCalls[0].body!).applyTo).toBe('Contents')
    })

    it('defaults applyTo to All when omitted', async () => {
      setResponseSequence(noContentResponse())
      const result = await clearRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10' } as any, makeContext())
      expect((result as any).applyTo).toBe('All')
    })
  })

  describe('sort-range', () => {
    it('builds the fields array Graph expects', async () => {
      setResponseSequence(noContentResponse())
      const result = await sortRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10', sortBy: [{ column: 0, ascending: true }, { column: 1, ascending: false }] } as any, makeContext())
      const body = JSON.parse(fetchCalls[0].body!)
      expect(body.fields).toEqual([{ key: 0, ascending: true, sortOn: 'Value' }, { key: 1, ascending: false, sortOn: 'Value' }])
    })

    it('rejects an empty sortBy before calling Graph', async () => {
      expect(sortRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10', sortBy: [] } as any, makeContext())).rejects.toThrow(/at least one key/)
      expect(fetchCalls.length).toBe(0)
    })

    it('rejects a sortBy entry missing a numeric column', async () => {
      expect(sortRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10', sortBy: [{ ascending: true }] } as any, makeContext())).rejects.toThrow(/numeric zero-based.*column/)
      expect(fetchCalls.length).toBe(0)
    })
  })

  describe('format-range', () => {
    it('sends number format sized to the range and styling on its format', async () => {
      setResponseSequence(
        jsonResponse({ rowCount: 2, columnCount: 2 }), // GET range dims
        jsonResponse({}), // PATCH range numberFormat
        jsonResponse({}), // PATCH range/format
      )
      const result = await formatRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'B2:B10', numberFormat: '$#,##0.00', bold: true } as any, makeContext())
      expect((result as any).applied).toContain('numberFormat')
      expect((result as any).applied).toContain('font')
    })

    it('rejects a call that specifies nothing to change', async () => {
      expect(formatRange.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'B2:B10' } as any, makeContext())).rejects.toThrow(/Specify at least one/)
    })
  })

  // ===========================================================================
  // ROWS AND COLUMNS
  // ===========================================================================

  describe('insert-rows-or-columns', () => {
    it('shifts down for rows', async () => {
      setResponseSequence(noContentResponse())
      const result = await insertRowsOrColumns.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: '3:4', direction: 'rows' } as any, makeContext())
      expect((result as any).shift).toBe('Down')
      expect(JSON.parse(fetchCalls[0].body!).shift).toBe('Down')
    })

    it('shifts right for columns', async () => {
      setResponseSequence(noContentResponse())
      const result = await insertRowsOrColumns.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'B:B', direction: 'columns' } as any, makeContext())
      expect((result as any).shift).toBe('Right')
    })

    it('rejects a direction other than rows or columns', async () => {
      expect(insertRowsOrColumns.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: '3:4', direction: 'sideways' } as any, makeContext())).rejects.toThrow(/rows.*columns/)
    })
  })

  describe('delete-rows-or-columns', () => {
    it('shifts up for rows', async () => {
      setResponseSequence(noContentResponse())
      const result = await deleteRowsOrColumns.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: '5:6', direction: 'rows' } as any, makeContext())
      expect((result as any).shift).toBe('Up')
    })

    it('shifts left for columns', async () => {
      setResponseSequence(noContentResponse())
      const result = await deleteRowsOrColumns.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'B:B', direction: 'columns' } as any, makeContext())
      expect((result as any).shift).toBe('Left')
    })
  })

  // ===========================================================================
  // TABLES
  // ===========================================================================

  describe('list-tables', () => {
    it('returns formatted tables across the workbook', async () => {
      setResponseSequence(jsonResponse({ value: [{ id: 't1', name: 'Table1', showHeaders: true, showTotals: false, style: 'TableStyleMedium2' }] }))
      const result = await listTables.handler!({ path: 'Budget.xlsx' } as any, makeContext())
      expect((result as any).count).toBe(1)
      expect((result as any).tables[0].name).toBe('Table1')
    })
  })

  describe('add-table', () => {
    it('posts the address and header flag to the worksheet', async () => {
      setResponseSequence(jsonResponse({ id: 't1', name: 'Table1', showHeaders: true, showTotals: false, style: 'TableStyleMedium2' }))
      const result = await addTable.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10' } as any, makeContext())
      expect((result as any).table.name).toBe('Table1')
      expect(JSON.parse(fetchCalls[0].body!).address).toBe('A1:C10')
      expect(JSON.parse(fetchCalls[0].body!).hasHeaders).toBe(true)
    })

    it('defaults hasHeaders to true when omitted', async () => {
      setResponseSequence(jsonResponse({ id: 't1', name: 'Table1', showHeaders: true, showTotals: false, style: 'TableStyleMedium2' }))
      await addTable.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10' } as any, makeContext())
      expect(JSON.parse(fetchCalls[0].body!).hasHeaders).toBe(true)
    })

    it('honours an explicit hasHeaders:false', async () => {
      setResponseSequence(jsonResponse({ id: 't1', name: 'Table1', showHeaders: false, showTotals: false, style: 'TableStyleMedium2' }))
      await addTable.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10', hasHeaders: false } as any, makeContext())
      expect(JSON.parse(fetchCalls[0].body!).hasHeaders).toBe(false)
    })
  })

  describe('add-table-rows', () => {
    it('appends rows and encodes the table name', async () => {
      setResponseSequence(jsonResponse({ index: 2 }))
      const result = await addTableRows.handler!({ path: 'Budget.xlsx', table: 'My Table', values: [['Widget', 9.5]] } as any, makeContext())
      expect((result as any).rowsAdded).toBe(1)
      expect(fetchCalls[0].url).toContain('My%20Table')
    })

    it('sends an explicit index when supplied', async () => {
      setResponseSequence(jsonResponse({ index: 5 }))
      await addTableRows.handler!({ path: 'Budget.xlsx', table: 'Table1', values: [['x']], index: 5 } as any, makeContext())
      expect(JSON.parse(fetchCalls[0].body!).index).toBe(5)
    })

    it('sends index 0 rather than dropping it as falsy', async () => {
      setResponseSequence(jsonResponse({ index: 0 }))
      await addTableRows.handler!({ path: 'Budget.xlsx', table: 'Table1', values: [['x']], index: 0 } as any, makeContext())
      expect(JSON.parse(fetchCalls[0].body!).index).toBe(0)
    })

    it('rejects a missing table before calling Graph', async () => {
      expect(addTableRows.handler!({ path: 'Budget.xlsx', values: [['x']] } as any, makeContext())).rejects.toThrow(/Specify table/)
      expect(fetchCalls.length).toBe(0)
    })

    it('rejects a non-rectangular payload before calling Graph', async () => {
      expect(addTableRows.handler!({ path: 'Budget.xlsx', table: 'T1', values: [['a', 'b'], ['c']] } as any, makeContext())).rejects.toThrow(/same number of cells/)
      expect(fetchCalls.length).toBe(0)
    })

    it('rejects an empty values array before calling Graph', async () => {
      expect(addTableRows.handler!({ path: 'Budget.xlsx', table: 'T1', values: [] } as any, makeContext())).rejects.toThrow(/non-empty/)
      expect(fetchCalls.length).toBe(0)
    })
  })

  // ===========================================================================
  // CHARTS
  // ===========================================================================

  describe('add-chart', () => {
    it('posts type, source data and series orientation', async () => {
      setResponseSequence(jsonResponse({ id: 'c1', name: 'Chart 1', height: 200, width: 400 }))
      const result = await addChart.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', chartType: 'ColumnClustered', sourceData: 'A1:B10' } as any, makeContext())
      expect((result as any).chart.name).toBe('Chart 1')
      expect(JSON.parse(fetchCalls[0].body!).type).toBe('ColumnClustered')
      expect(JSON.parse(fetchCalls[0].body!).sourceData).toBe('A1:B10')
    })

    it('defaults seriesBy to Columns when omitted', async () => {
      setResponseSequence(jsonResponse({ id: 'c1', name: 'Chart 1' }))
      await addChart.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', chartType: 'Line', sourceData: 'A1:B10' } as any, makeContext())
      expect(JSON.parse(fetchCalls[0].body!).seriesBy).toBe('Columns')
    })
  })

  describe('get-chart-image', () => {
    it('returns the base64 PNG and encodes the chart name', async () => {
      const smallBase64 = Buffer.alloc(100, 0).toString('base64')
      setResponseSequence(jsonResponse({ value: smallBase64 }))
      const result = await getChartImage.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', chart: 'Chart 1' } as any, makeContext())
      expect((result as any).mimeType).toBe('image/png')
      expect((result as any).base64).toBe(smallBase64)
      expect(fetchCalls[0].url).toContain('Chart%201')
    })

    it('omits the dimensions suffix when width and height are not supplied', async () => {
      const smallBase64 = Buffer.alloc(100, 0).toString('base64')
      setResponseSequence(jsonResponse({ value: smallBase64 }))
      await getChartImage.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', chart: 'Chart1' } as any, makeContext())
      expect(fetchCalls[0].url).not.toContain('(')
    })

    it('joins width and height into a single suffix when both are supplied', async () => {
      const smallBase64 = Buffer.alloc(100, 0).toString('base64')
      setResponseSequence(jsonResponse({ value: smallBase64 }))
      await getChartImage.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', chart: 'Chart1', width: 800, height: 600 } as any, makeContext())
      expect(fetchCalls[0].url).toContain('(width=800,height=600)')
    })

    it('rejects a missing chart before calling Graph', async () => {
      expect(getChartImage.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1' } as any, makeContext())).rejects.toThrow(/Specify chart/)
      expect(fetchCalls.length).toBe(0)
    })

    it('refuses an oversized render and points at width and height', async () => {
      const bigBase64 = Buffer.alloc(6 * 1024 * 1024, 0).toString('base64')
      setResponseSequence(jsonResponse({ value: bigBase64 }))
      expect(getChartImage.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', chart: 'Chart1' } as any, makeContext())).rejects.toThrow(/over.*limit.*width.*height/)
    })

    it('reports a chart that returned no image data', async () => {
      setResponseSequence(jsonResponse({ value: null }))
      expect(getChartImage.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', chart: 'Chart1' } as any, makeContext())).rejects.toThrow(/no image data/)
    })
  })

  // ===========================================================================
  // CHART MANAGEMENT
  // ===========================================================================

  describe('list-charts', () => {
    it('returns formatted charts from the worksheet', async () => {
      setResponseSequence(jsonResponse({ value: [{ id: 'c1', name: 'Chart 1', chartType: 'ColumnClustered', height: 200, width: 400, top: 10, left: 10 }, { id: 'c2', name: 'Chart 2', chartType: 'Line', height: 200, width: 400, top: 10, left: 300 }] }))
      const result = await listCharts.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1' } as any, makeContext())
      expect((result as any).count).toBe(2)
      expect((result as any).charts[0].name).toBe('Chart 1')
      expect((result as any).charts[0].type).toBe('ColumnClustered')
    })

    it('returns an empty list when the worksheet has no charts', async () => {
      setResponseSequence(jsonResponse({ value: [] }))
      const result = await listCharts.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1' } as any, makeContext())
      expect((result as any).count).toBe(0)
    })
  })

  describe('delete-chart', () => {
    it('deletes the chart by name', async () => {
      setResponseSequence(noContentResponse())
      const result = await deleteChart.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', chart: 'Chart 1' } as any, makeContext())
      expect((result as any).action).toBe('deleted')
      expect(fetchCalls[0].method).toBe('DELETE')
      expect(fetchCalls[0].url).toContain('Chart%201')
    })
  })

  // ===========================================================================
  // CELL LAYOUT
  // ===========================================================================

  describe('merge-cells', () => {
    it('posts merge with default orientation', async () => {
      setResponseSequence(noContentResponse())
      const result = await mergeCells.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10' } as any, makeContext())
      expect((result as any).action).toBe('merged')
      expect((result as any).orientation).toBe('all')
      expect(JSON.parse(fetchCalls[0].body!).orientation).toBe('all')
      expect(fetchCalls[0].url).toContain('/merge')
    })

    it('honours the across orientation', async () => {
      setResponseSequence(noContentResponse())
      const result = await mergeCells.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10', orientation: 'across' } as any, makeContext())
      expect((result as any).orientation).toBe('across')
      expect(JSON.parse(fetchCalls[0].body!).orientation).toBe('across')
    })

    it('unmerges when unmerge is true', async () => {
      setResponseSequence(noContentResponse())
      const result = await mergeCells.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10', unmerge: true } as any, makeContext())
      expect((result as any).action).toBe('unmerged')
      expect(fetchCalls[0].url).toContain('/unmerge')
    })
  })

  describe('set-column-width', () => {
    it('patches columnWidth when width is provided', async () => {
      setResponseSequence(noContentResponse())
      const result = await setColumnWidth.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A:C', width: 25 } as any, makeContext())
      expect((result as any).action).toBe('setWidth')
      expect((result as any).width).toBe(25)
      expect(JSON.parse(fetchCalls[0].body!).columnWidth).toBe(25)
      expect(fetchCalls[0].url).toContain('/format')
    })

    it('auto-fits when width is omitted', async () => {
      setResponseSequence(noContentResponse())
      const result = await setColumnWidth.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A:C' } as any, makeContext())
      expect((result as any).action).toBe('autoFit')
      expect(fetchCalls[0].url).toContain('autofitColumns')
    })
  })

  describe('set-row-height', () => {
    it('patches rowHeight when height is provided', async () => {
      setResponseSequence(noContentResponse())
      const result = await setRowHeight.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: '1:10', height: 30 } as any, makeContext())
      expect((result as any).action).toBe('setHeight')
      expect((result as any).height).toBe(30)
      expect(JSON.parse(fetchCalls[0].body!).rowHeight).toBe(30)
    })

    it('auto-fits when height is omitted', async () => {
      setResponseSequence(noContentResponse())
      const result = await setRowHeight.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: '1:10' } as any, makeContext())
      expect((result as any).action).toBe('autoFit')
      expect(fetchCalls[0].url).toContain('autofitRows')
    })
  })

  describe('add-borders', () => {
    it('patches each border individually', async () => {
      setResponseSequence(noContentResponse(), noContentResponse())
      const result = await addBorders.handler!({
        path: 'Budget.xlsx',
        worksheet: 'Sheet1',
        address: 'A1:C10',
        borders: [
          { side: 'EdgeTop', style: 'Continuous', color: '#000000' },
          { side: 'EdgeBottom', style: 'Double' },
        ],
      } as any, makeContext())
      expect((result as any).applied).toHaveLength(2)
      expect((result as any).applied[0].side).toBe('EdgeTop')
      expect(fetchCalls[0].url).toContain('EdgeTop')
      expect(JSON.parse(fetchCalls[0].body!).style).toBe('Continuous')
      expect(JSON.parse(fetchCalls[0].body!).color).toBe('#000000')
      expect(fetchCalls[1].url).toContain('EdgeBottom')
      expect(JSON.parse(fetchCalls[1].body!).style).toBe('Double')
    })

    it('rejects an empty borders array before calling Graph', async () => {
      expect(addBorders.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10', borders: [] } as any, makeContext())).rejects.toThrow(/at least one border/)
      expect(fetchCalls.length).toBe(0)
    })

    it('rejects a border missing side or style', async () => {
      expect(addBorders.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10', borders: [{ side: 'EdgeTop' }] } as any, makeContext())).rejects.toThrow(/both side and style/)
      expect(fetchCalls.length).toBe(0)
    })
  })

  // ===========================================================================
  // CONDITIONAL FORMATTING
  // ===========================================================================

  describe('add-conditional-format', () => {
    it('adds a CellValue rule with operator and formula', async () => {
      setResponseSequence(jsonResponse({ id: 'cf1' }))
      const result = await addConditionalFormat.handler!({
        path: 'Budget.xlsx',
        worksheet: 'Sheet1',
        address: 'A1:A10',
        ruleType: 'CellValue',
        operator: 'GreaterThan',
        formula: '0',
        fill: { color: '#FF0000' },
      } as any, makeContext())
      expect((result as any).action).toBe('added')
      expect((result as any).ruleType).toBe('CellValue')
      const body = JSON.parse(fetchCalls[0].body!)
      expect(body.cellValue.operator).toBe('GreaterThan')
      expect(body.cellValue.formula).toEqual(['0'])
      expect(body.format.fill.color).toBe('#FF0000')
    })

    it('rejects CellValue without operator or formula', async () => {
      expect(addConditionalFormat.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:A10', ruleType: 'CellValue' } as any, makeContext())).rejects.toThrow(/operator and formula/)
      expect(fetchCalls.length).toBe(0)
    })

    it('lists existing rules when list:true', async () => {
      setResponseSequence(jsonResponse({ value: [{ id: 'cf1', type: 'CellValue' }] }))
      const result = await addConditionalFormat.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:A10', list: true } as any, makeContext())
      expect((result as any).count).toBe(1)
      expect((result as any).rules[0].type).toBe('CellValue')
    })

    it('deletes a rule by index', async () => {
      setResponseSequence(
        jsonResponse({ value: [{ id: 'cf1', type: 'CellValue' }, { id: 'cf2', type: 'ColorScale' }] }),
        noContentResponse(),
      )
      const result = await addConditionalFormat.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:A10', deleteIndex: 1 } as any, makeContext())
      expect((result as any).action).toBe('deleted')
      expect((result as any).deletedIndex).toBe(1)
      expect(fetchCalls[1].method).toBe('DELETE')
    })

    it('rejects an unknown ruleType', async () => {
      expect(addConditionalFormat.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:A10', ruleType: 'Unknown' } as any, makeContext())).rejects.toThrow(/Unknown ruleType/)
      expect(fetchCalls.length).toBe(0)
    })
  })

  // ===========================================================================
  // DATA VALIDATION
  // ===========================================================================

  describe('set-data-validation', () => {
    it('patches a List validation (dropdown)', async () => {
      setResponseSequence(noContentResponse())
      const result = await setDataValidation.handler!({
        path: 'Budget.xlsx',
        worksheet: 'Sheet1',
        address: 'A1:A10',
        validationType: 'List',
        formula1: 'Yes,No,Maybe',
      } as any, makeContext())
      expect((result as any).action).toBe('set')
      expect((result as any).validationType).toBe('List')
      const body = JSON.parse(fetchCalls[0].body!)
      expect(body.type).toBe('List')
      expect(body.formula1).toBe('Yes,No,Maybe')
    })

    it('patches a WholeNumber validation with operator', async () => {
      setResponseSequence(noContentResponse())
      const result = await setDataValidation.handler!({
        path: 'Budget.xlsx',
        worksheet: 'Sheet1',
        address: 'B1:B10',
        validationType: 'WholeNumber',
        operator: 'GreaterThan',
        formula1: '0',
      } as any, makeContext())
      const body = JSON.parse(fetchCalls[0].body!)
      expect(body.type).toBe('WholeNumber')
      expect(body.operator).toBe('GreaterThan')
    })

    it('rejects a numeric type without operator', async () => {
      expect(setDataValidation.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'B1:B10', validationType: 'WholeNumber' } as any, makeContext())).rejects.toThrow(/requires an operator/)
      expect(fetchCalls.length).toBe(0)
    })

    it('clears validation when clear is true', async () => {
      setResponseSequence(noContentResponse())
      const result = await setDataValidation.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:A10', clear: true } as any, makeContext())
      expect((result as any).action).toBe('cleared')
      expect(fetchCalls[0].url).toContain('/dataValidation/clear')
    })

    it('rejects a call with no validationType and no clear', async () => {
      expect(setDataValidation.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:A10' } as any, makeContext())).rejects.toThrow(/Specify validationType/)
      expect(fetchCalls.length).toBe(0)
    })
  })

  // ===========================================================================
  // COMMENTS
  // ===========================================================================

  describe('add-comment', () => {
    it('adds a comment to a cell', async () => {
      setResponseSequence(jsonResponse({ id: 'comment1', content: 'Hello' }))
      const result = await addComment.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', cell: 'A1', content: 'Hello' } as any, makeContext())
      expect((result as any).action).toBe('added')
      expect((result as any).cell).toBe('A1')
      const body = JSON.parse(fetchCalls[0].body!)
      expect(body.targetRange).toBe('A1')
      expect(body.content).toBe('Hello')
    })

    it('lists all comments on a worksheet', async () => {
      setResponseSequence(jsonResponse({ value: [{ id: 'c1', content: 'Note', author: { displayName: 'Test' }, createdDateTime: '2026-01-01' }] }))
      const result = await addComment.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', list: true } as any, makeContext())
      expect((result as any).count).toBe(1)
      expect((result as any).comments[0].content).toBe('Note')
    })

    it('deletes a comment by id', async () => {
      setResponseSequence(noContentResponse())
      const result = await addComment.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', deleteId: 'c1' } as any, makeContext())
      expect((result as any).action).toBe('deleted')
      expect(fetchCalls[0].method).toBe('DELETE')
    })

    it('updates a comment by id', async () => {
      setResponseSequence(jsonResponse({ id: 'c1', content: 'Updated' }))
      const result = await addComment.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', updateId: 'c1', content: 'Updated' } as any, makeContext())
      expect((result as any).action).toBe('updated')
      expect(JSON.parse(fetchCalls[0].body!).content).toBe('Updated')
    })

    it('rejects adding without cell or content', async () => {
      expect(addComment.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1' } as any, makeContext())).rejects.toThrow(/Specify cell/)
      expect(addComment.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', cell: 'A1' } as any, makeContext())).rejects.toThrow(/Specify content/)
    })
  })

  // ===========================================================================
  // HYPERLINKS
  // ===========================================================================

  describe('add-hyperlink', () => {
    it('writes a HYPERLINK formula into the cell', async () => {
      setResponseSequence(jsonResponse({ address: 'A1', rowCount: 1, columnCount: 1 }))
      const result = await addHyperlink.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1', url: 'https://example.com', displayText: 'Click here' } as any, makeContext())
      expect((result as any).url).toBe('https://example.com')
      expect((result as any).displayText).toBe('Click here')
      const body = JSON.parse(fetchCalls[0].body!)
      expect(body.formulas[0][0]).toContain('=HYPERLINK(')
      expect(body.formulas[0][0]).toContain('https://example.com')
      expect(body.formulas[0][0]).toContain('Click here')
    })

    it('defaults displayText to the URL', async () => {
      setResponseSequence(jsonResponse({ address: 'A1', rowCount: 1, columnCount: 1 }))
      const result = await addHyperlink.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1', url: 'https://example.com' } as any, makeContext())
      expect((result as any).displayText).toBe('https://example.com')
    })
  })

  // ===========================================================================
  // PROTECTION
  // ===========================================================================

  describe('protect-sheet', () => {
    it('protects a worksheet with default options', async () => {
      setResponseSequence(noContentResponse())
      const result = await protectSheet.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1' } as any, makeContext())
      expect((result as any).action).toBe('protected')
      expect(fetchCalls[0].url).toContain('/protection/protect')
      const body = JSON.parse(fetchCalls[0].body!)
      expect(body.allowFormatCells).toBe(false)
    })

    it('passes through allowed operations', async () => {
      setResponseSequence(noContentResponse())
      const result = await protectSheet.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', allowSort: true, allowAutoFilter: true } as any, makeContext())
      const body = JSON.parse(fetchCalls[0].body!)
      expect(body.allowSort).toBe(true)
      expect(body.allowAutoFilter).toBe(true)
      expect(body.allowFormatCells).toBe(false)
    })

    it('unprotects when unprotect is true', async () => {
      setResponseSequence(noContentResponse())
      const result = await protectSheet.handler!({ path: 'Budget.xlsx', worksheet: 'Sheet1', unprotect: true } as any, makeContext())
      expect((result as any).action).toBe('unprotected')
      expect(fetchCalls[0].url).toContain('/protection/unprotect')
    })
  })
})
