/**
 * Unit tests for Word addressing helpers.
 *
 * Ported from agentapps-private/test/microsoft-word.test.ts (helper section),
 * adapted from vitest to bun:test.
 */

import { describe, expect, it } from 'bun:test'
import {
  assertDocxName,
  encodePathSegments,
  formatItem,
  itemAction,
  itemRef,
  normalizePath,
} from '../../src/lib/helpers'

describe('normalizePath', () => {
  it('strips a leading slash', () => {
    expect(normalizePath('/Reports/Q3.docx')).toBe('Reports/Q3.docx')
  })

  it('strips multiple leading slashes', () => {
    expect(normalizePath('///Reports/Q3.docx')).toBe('Reports/Q3.docx')
  })

  it('normalizes a bare slash to an empty string', () => {
    expect(normalizePath('/')).toBe('')
  })

  it('normalizes an empty string to an empty string', () => {
    expect(normalizePath('')).toBe('')
  })
})

describe('encodePathSegments', () => {
  it('encodes a `#` inside a segment', () => {
    expect(encodePathSegments('Reports/2026#final.docx')).toBe('Reports/2026%23final.docx')
  })

  it('preserves the `/` separators rather than encoding them as %2F', () => {
    expect(encodePathSegments('Reports/Q3.docx')).toBe('Reports/Q3.docx')
  })

  it('encodes a `?` inside a segment', () => {
    expect(encodePathSegments('What?.docx')).toBe('What%3F.docx')
  })
})

describe('assertDocxName', () => {
  it('accepts .docx case-insensitively', () => {
    expect(() => assertDocxName('report.DOCX')).not.toThrow()
    expect(() => assertDocxName('report.docx')).not.toThrow()
    expect(() => assertDocxName('/Finance/report.Docx')).not.toThrow()
  })

  it('rejects a non-.docx extension', () => {
    expect(() => assertDocxName('report.doc')).toThrow(/not one.*\.docx files|legacy \.doc/)
    expect(() => assertDocxName('report.txt')).toThrow(/not one.*\.docx files|legacy \.doc/)
    expect(() => assertDocxName('report')).toThrow(/not one.*\.docx files|legacy \.doc/)
  })
})

describe('itemRef', () => {
  it('builds the itemId form', () => {
    expect(itemRef({ itemId: 'i1' })).toBe('/me/drive/items/i1')
  })

  it('builds the path form', () => {
    expect(itemRef({ path: 'Reports/Q3.docx' })).toBe('/me/drive/root:/Reports/Q3.docx')
  })

  it('encodes special characters in the path', () => {
    expect(itemRef({ path: 'Reports/2026#final.docx' })).toBe(
      '/me/drive/root:/Reports/2026%23final.docx',
    )
  })

  it('strips a leading slash on the path', () => {
    expect(itemRef({ path: '/Reports/q3.docx' })).toBe('/me/drive/root:/Reports/q3.docx')
  })

  it('throws when neither itemId nor path is given, rather than defaulting', () => {
    expect(() => itemRef({})).toThrow(/itemId/)
    expect(() => itemRef({ itmId: 'typo' })).toThrow(/itemId/)
  })

  it('itemId takes precedence over path', () => {
    expect(itemRef({ itemId: 'ID1', path: 'test.docx' })).toBe('/me/drive/items/ID1')
  })
})

describe('itemAction', () => {
  it('terminates a path reference before the action segment', () => {
    expect(itemAction('/me/drive/root:/Reports/Q3.docx', '/content')).toBe(
      '/me/drive/root:/Reports/Q3.docx:/content',
    )
  })

  it('does not add a terminator on the id form', () => {
    expect(itemAction('/me/drive/items/i1', '/content')).toBe('/me/drive/items/i1/content')
  })

  it('handles a query-carrying action on the path form', () => {
    expect(itemAction('/me/drive/root:/Reports/Q3.docx', '/content?format=pdf')).toBe(
      '/me/drive/root:/Reports/Q3.docx:/content?format=pdf',
    )
  })
})

describe('formatItem', () => {
  it('returns the canonical shape', () => {
    const item = {
      id: 'i1',
      name: 'Report.docx',
      size: 2324,
      createdDateTime: '2026-08-01T00:00:00Z',
      lastModifiedDateTime: '2026-08-02T00:00:00Z',
      webUrl: 'https://onedrive.com/i1',
      extra: 'ignored',
    }
    expect(formatItem(item)).toEqual({
      id: 'i1',
      name: 'Report.docx',
      size: 2324,
      createdDateTime: '2026-08-01T00:00:00Z',
      lastModifiedDateTime: '2026-08-02T00:00:00Z',
      webUrl: 'https://onedrive.com/i1',
    })
  })

  it('handles nullish fields gracefully', () => {
    expect(formatItem({})).toEqual({
      id: null,
      name: null,
      size: null,
      createdDateTime: null,
      lastModifiedDateTime: null,
      webUrl: null,
    })
  })
})
