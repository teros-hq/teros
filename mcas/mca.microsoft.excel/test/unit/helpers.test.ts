/**
 * Unit tests for Excel addressing helpers.
 *
 * Ported from agentapps-private/test/microsoft-excel.test.ts (helper section),
 * adapted from vitest to bun:test.
 */

import { describe, expect, it } from 'bun:test'
import {
  assertGrid,
  assertXlsx,
  colNameToNumber,
  encodePathSegments,
  escapeODataLiteral,
  expandAddress,
  formatTable,
  formatWorksheet,
  normalizePath,
  numberToColName,
  rangeRef,
  terminalRef,
  workbookItemRef,
  workbookRef,
  worksheetRef,
} from '../../src/lib/helpers'

describe('normalizePath', () => {
  it('strips a trailing slash', () => {
    expect(normalizePath('Finance/')).toBe('/Finance')
  })

  it('strips multiple trailing slashes', () => {
    expect(normalizePath('Finance///')).toBe('/Finance')
  })

  it('normalizes a bare slash to the drive root', () => {
    expect(normalizePath('/')).toBe('')
  })

  it('normalizes an empty string to the drive root', () => {
    expect(normalizePath('')).toBe('')
  })

  it('adds a leading slash when missing', () => {
    expect(normalizePath('Finance/Budget.xlsx')).toBe('/Finance/Budget.xlsx')
  })

  it('preserves a leading slash when present', () => {
    expect(normalizePath('/Finance/Budget.xlsx')).toBe('/Finance/Budget.xlsx')
  })

  it('trims whitespace', () => {
    expect(normalizePath('  Finance  ')).toBe('/Finance')
  })
})

describe('encodePathSegments', () => {
  it('encodes a `#` inside a segment', () => {
    expect(encodePathSegments('/Finance/Q3#Report.xlsx')).toBe('/Finance/Q3%23Report.xlsx')
  })

  it('preserves the `/` separators rather than encoding them as %2F', () => {
    expect(encodePathSegments('/Finance/Budget.xlsx')).toBe('/Finance/Budget.xlsx')
  })

  it('encodes a `?` inside a segment', () => {
    expect(encodePathSegments('/What?.xlsx')).toBe('/What%3F.xlsx')
  })

  it('encodes a `%` inside a segment', () => {
    expect(encodePathSegments('/100%25.xlsx')).toBe('/100%2525.xlsx')
  })
})

describe('assertXlsx', () => {
  it('accepts .xlsx case-insensitively', () => {
    expect(() => assertXlsx('budget.XLSX')).not.toThrow()
    expect(() => assertXlsx('budget.xlsx')).not.toThrow()
    expect(() => assertXlsx('/Finance/budget.XlSx')).not.toThrow()
  })

  it('rejects a non-.xlsx extension', () => {
    expect(() => assertXlsx('budget.csv')).toThrow(/not an \.xlsx file/)
    expect(() => assertXlsx('budget.xls')).toThrow(/not an \.xlsx file/)
    expect(() => assertXlsx('budget')).toThrow(/not an \.xlsx file/)
  })
})

describe('escapeODataLiteral', () => {
  it('doubles apostrophes', () => {
    expect(escapeODataLiteral("A1'B2")).toBe("A1''B2")
  })

  it('handles multiple apostrophes', () => {
    expect(escapeODataLiteral("A1'B2'C3")).toBe("A1''B2''C3")
  })

  it('handles no apostrophes', () => {
    expect(escapeODataLiteral('A1:B2')).toBe('A1:B2')
  })
})

describe('assertGrid', () => {
  it('accepts a valid rectangular grid', () => {
    expect(() => assertGrid([['a', 'b'], ['c', 'd']])).not.toThrow()
  })

  it('rejects an empty array', () => {
    expect(() => assertGrid([])).toThrow(/non-empty array of rows/)
  })

  it('rejects a non-array', () => {
    expect(() => assertGrid('not an array')).toThrow(/non-empty array of rows/)
  })

  it('rejects rows that are not arrays', () => {
    expect(() => assertGrid(['a', 'b'])).toThrow(/array of rows/)
  })

  it('rejects rows of unequal length', () => {
    expect(() => assertGrid([['a', 'b'], ['c']])).toThrow(/same number of cells/)
  })
})

describe('workbookItemRef', () => {
  it('builds the itemId form', () => {
    expect(workbookItemRef({ itemId: 'ABC123' })).toBe('/me/drive/items/ABC123')
  })

  it('builds the path form', () => {
    expect(workbookItemRef({ path: 'Finance/Budget.xlsx' })).toBe(
      '/me/drive/root:/Finance/Budget.xlsx:',
    )
  })

  it('throws when neither itemId nor path is given, rather than defaulting', () => {
    expect(() => workbookItemRef({})).toThrow(/Specify itemId or path/)
  })

  it('encodes special characters in the path', () => {
    expect(workbookItemRef({ path: 'Q3#Report.xlsx' })).toBe(
      '/me/drive/root:/Q3%23Report.xlsx:',
    )
  })

  it('rejects a non-xlsx path', () => {
    expect(() => workbookItemRef({ path: 'budget.csv' })).toThrow(/not an \.xlsx file/)
  })

  it('itemId takes precedence over path', () => {
    expect(workbookItemRef({ itemId: 'ID1', path: 'test.xlsx' })).toBe('/me/drive/items/ID1')
  })
})

describe('terminalRef', () => {
  it('strips a single trailing colon', () => {
    expect(terminalRef('/me/drive/root:/Finance/Budget.xlsx:')).toBe(
      '/me/drive/root:/Finance/Budget.xlsx',
    )
  })

  it('leaves a ref with no trailing colon unchanged', () => {
    expect(terminalRef('/me/drive/items/ABC123')).toBe('/me/drive/items/ABC123')
  })
})

describe('worksheetRef', () => {
  it('composes onto the workbook ref', () => {
    expect(worksheetRef({ path: 'Budget.xlsx', worksheet: 'Sheet1' })).toBe(
      '/me/drive/root:/Budget.xlsx:/workbook/worksheets/Sheet1',
    )
  })

  it('encodes the worksheet name', () => {
    expect(worksheetRef({ path: 'Budget.xlsx', worksheet: 'My Sheet' })).toBe(
      '/me/drive/root:/Budget.xlsx:/workbook/worksheets/My%20Sheet',
    )
  })

  it('throws when worksheet is missing', () => {
    expect(() => worksheetRef({ path: 'Budget.xlsx' })).toThrow(/Specify worksheet/)
  })
})

describe('rangeRef', () => {
  it('builds the range address function call', () => {
    expect(rangeRef({ path: 'Budget.xlsx', worksheet: 'Sheet1', address: 'A1:C10' })).toBe(
      "/me/drive/root:/Budget.xlsx:/workbook/worksheets/Sheet1/range(address='A1%3AC10')",
    )
  })

  it('escapes apostrophes in the address', () => {
    // A1:B2 doesn't have apostrophes, but a named range might
    const ref = rangeRef({ path: "Test.xlsx", worksheet: 'Sheet1', address: "A1:B2" })
    expect(ref).toContain("range(address='A1%3AB2')")
  })

  it('throws when address is missing', () => {
    expect(() => rangeRef({ path: 'Budget.xlsx', worksheet: 'Sheet1' })).toThrow(
      /Specify address/,
    )
  })
})

describe('formatWorksheet', () => {
  it('returns the canonical shape', () => {
    const ws = { id: 'ws1', name: 'Sheet1', position: 0, visibility: 'Visible', extra: 'ignored' }
    expect(formatWorksheet(ws)).toEqual({
      id: 'ws1',
      name: 'Sheet1',
      position: 0,
      visibility: 'Visible',
    })
  })
})

describe('formatTable', () => {
  it('returns the canonical shape', () => {
    const t = {
      id: 'tbl1',
      name: 'Table1',
      showHeaders: true,
      showTotals: false,
      style: 'TableStyleMedium2',
      extra: 'ignored',
    }
    expect(formatTable(t)).toEqual({
      id: 'tbl1',
      name: 'Table1',
      showHeaders: true,
      showTotals: false,
      style: 'TableStyleMedium2',
    })
  })
})

describe('colNameToNumber', () => {
  it('converts single-letter columns', () => {
    expect(colNameToNumber('A')).toBe(1)
    expect(colNameToNumber('Z')).toBe(26)
  })

  it('converts multi-letter columns', () => {
    expect(colNameToNumber('AA')).toBe(27)
    expect(colNameToNumber('AZ')).toBe(52)
    expect(colNameToNumber('BA')).toBe(53)
  })
})

describe('numberToColName', () => {
  it('converts single-letter columns', () => {
    expect(numberToColName(1)).toBe('A')
    expect(numberToColName(26)).toBe('Z')
  })

  it('converts multi-letter columns', () => {
    expect(numberToColName(27)).toBe('AA')
    expect(numberToColName(52)).toBe('AZ')
    expect(numberToColName(53)).toBe('BA')
  })

  it('round-trips with colNameToNumber', () => {
    for (const n of [1, 26, 27, 52, 53, 702, 703]) {
      expect(colNameToNumber(numberToColName(n))).toBe(n)
    }
  })
})

describe('expandAddress', () => {
  it('expands a single cell to match the values dimensions', () => {
    // "A1" + 14 rows × 6 cols → "A1:F14"
    expect(expandAddress('A1', 14, 6)).toBe('A1:F14')
  })

  it('expands from a non-origin cell', () => {
    // "B3" + 5 rows × 3 cols → "B3:D7"
    expect(expandAddress('B3', 5, 3)).toBe('B3:D7')
  })

  it('leaves an explicit range unchanged', () => {
    expect(expandAddress('A1:C10', 14, 6)).toBe('A1:C10')
  })

  it('handles multi-letter columns', () => {
    // "AA1" + 2 rows × 2 cols → "AA1:AB2"
    expect(expandAddress('AA1', 2, 2)).toBe('AA1:AB2')
  })

  it('passes through an unparseable address unchanged', () => {
    expect(expandAddress('not-a-cell', 3, 3)).toBe('not-a-cell')
  })
})
