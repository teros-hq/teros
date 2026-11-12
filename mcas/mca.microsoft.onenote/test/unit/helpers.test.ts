/**
 * Unit tests for OneNote helpers.
 *
 * Ported from agentapps-private/test/microsoft-onenote.test.ts (helper section),
 * adapted from vitest to bun:test.
 */

import { describe, expect, it } from 'bun:test'
import {
  assertDisplayName,
  buildMultipartPage,
  buildPageHtml,
  escapeHtml,
  escapeODataLiteral,
  formatNotebook,
  formatPage,
  formatSection,
  formatSectionGroup,
  htmlToMarkdown,
  markdownToHtmlFragment,
  optionalId,
  pollOperation,
  requireId,
} from '../../src/lib/helpers'
import type { GraphRequestFn } from '../../src/lib/helpers'

// ===========================================================================
// escapeODataLiteral
// ===========================================================================

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

// ===========================================================================
// escapeHtml
// ===========================================================================

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
  })

  it('escapes quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;')
    expect(escapeHtml("it's")).toBe("it&#39;s")
  })

  it('passes through plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
  })
})

// ===========================================================================
// requireId / optionalId
// ===========================================================================

describe('requireId', () => {
  it('resolves the first non-empty string among names', () => {
    const ref = requireId({ b: 'id-123' }, ['a', 'b', 'c'], 'test')
    expect(ref.id).toBe('id-123')
    expect(ref.encoded).toBe('id-123')
  })

  it('trims whitespace from the id', () => {
    const ref = requireId({ a: '  id-1  ' }, ['a'], 'test')
    expect(ref.id).toBe('id-1')
    expect(ref.encoded).toBe('id-1')
  })

  it('percent-encodes special characters for URL safety', () => {
    const ref = requireId({ a: 'id with spaces' }, ['a'], 'test')
    expect(ref.encoded).toBe('id%20with%20spaces')
  })

  it('throws when no name matches', () => {
    expect(() => requireId({}, ['a', 'b'], 'the thing')).toThrow(/Specify a or b/)
  })

  it('throws when the value is an empty string', () => {
    expect(() => requireId({ a: '' }, ['a'], 'the thing')).toThrow(/Specify a/)
  })

  it('throws when the value is only whitespace', () => {
    expect(() => requireId({ a: '   ' }, ['a'], 'the thing')).toThrow(/Specify a/)
  })

  it('ignores non-string values', () => {
    expect(() => requireId({ a: 123 }, ['a'], 'the thing')).toThrow(/Specify a/)
  })
})

describe('optionalId', () => {
  it('returns undefined when no name matches', () => {
    expect(optionalId({}, ['a'])).toBeUndefined()
  })

  it('returns the ref when found', () => {
    expect(optionalId({ a: 'id-1' }, ['a'])?.id).toBe('id-1')
  })
})

// ===========================================================================
// assertDisplayName
// ===========================================================================

describe('assertDisplayName', () => {
  it('accepts a valid name', () => {
    expect(assertDisplayName('My Notebook', 'notebook name')).toBe('My Notebook')
  })

  it('trims whitespace', () => {
    expect(assertDisplayName('  My Notebook  ', 'notebook name')).toBe('My Notebook')
  })

  it('rejects an empty string', () => {
    expect(() => assertDisplayName('', 'notebook name')).toThrow(/non-empty name/)
  })

  it('rejects a non-string', () => {
    expect(() => assertDisplayName(123, 'notebook name')).toThrow(/non-empty name/)
  })

  it('rejects a name with disallowed characters', () => {
    expect(() => assertDisplayName('book?name', 'notebook name')).toThrow(/does not allow/)
    expect(() => assertDisplayName('book:name', 'notebook name')).toThrow(/does not allow/)
    expect(() => assertDisplayName('book/name', 'notebook name')).toThrow(/does not allow/)
    expect(() => assertDisplayName('book\\name', 'notebook name')).toThrow(/does not allow/)
    expect(() => assertDisplayName('book*name', 'notebook name')).toThrow(/does not allow/)
  })

  it('rejects a name longer than 50 characters', () => {
    const long = 'a'.repeat(51)
    expect(() => assertDisplayName(long, 'notebook name')).toThrow(/50 characters/)
  })

  it('accepts a name of exactly 50 characters', () => {
    const max = 'a'.repeat(50)
    expect(assertDisplayName(max, 'notebook name')).toBe(max)
  })
})

// ===========================================================================
// markdownToHtmlFragment
// ===========================================================================

describe('markdownToHtmlFragment', () => {
  it('converts markdown to HTML', async () => {
    const html = await markdownToHtmlFragment('# Hello', 'markdown')
    expect(html).toContain('<h1>')
    expect(html).toContain('Hello')
  })

  it('passes HTML through unchanged', async () => {
    const html = '<p>Already HTML</p>'
    expect(await markdownToHtmlFragment(html, 'html')).toBe(html)
  })

  it('defaults to markdown format', async () => {
    const html = await markdownToHtmlFragment('**bold**')
    expect(html).toContain('<strong>bold</strong>')
  })
})

// ===========================================================================
// buildPageHtml
// ===========================================================================

describe('buildPageHtml', () => {
  it('wraps body in an HTML document with the title escaped', () => {
    const html = buildPageHtml('My <Page>', '<p>Body</p>')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<title>My &lt;Page&gt;</title>')
    expect(html).toContain('<body><p>Body</p></body>')
  })

  it('does not escape the body (it is generated markup)', () => {
    const html = buildPageHtml('Title', '<strong>bold</strong>')
    expect(html).toContain('<strong>bold</strong>')
  })
})

// ===========================================================================
// htmlToMarkdown
// ===========================================================================

describe('htmlToMarkdown', () => {
  it('converts HTML to markdown', () => {
    const md = htmlToMarkdown('<h1>Title</h1><p>Body text</p>')
    expect(md).toContain('# Title')
    expect(md).toContain('Body text')
  })

  it('converts unordered lists', () => {
    const md = htmlToMarkdown('<ul><li>One</li><li>Two</li></ul>')
    expect(md).toContain('One')
    expect(md).toContain('Two')
    expect(md.trim().split('\n').every((l) => l.startsWith('-'))).toBe(true)
  })

  it('converts code blocks', () => {
    const md = htmlToMarkdown('<pre><code>const x = 1</code></pre>')
    expect(md).toContain('```')
    expect(md).toContain('const x = 1')
  })

  it('trims output', () => {
    const md = htmlToMarkdown('  <p>text</p>  ')
    expect(md).toBe('text')
  })
})

// ===========================================================================
// buildMultipartPage
// ===========================================================================

describe('buildMultipartPage', () => {
  it('builds a multipart body with the Presentation part', () => {
    const { body, contentType } = buildMultipartPage('<p>Hello</p>')
    const bodyStr = body.toString('utf-8')
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(bodyStr).toContain('Content-Disposition: form-data; name="Presentation"')
    expect(bodyStr).toContain('Content-Type: text/html')
    expect(bodyStr).toContain('<p>Hello</p>')
  })

  it('uses CRLF line endings', () => {
    const { body } = buildMultipartPage('<p>Test</p>')
    expect(body.toString('utf-8')).toContain('\r\n')
  })

  it('ends with a closing boundary', () => {
    const { body, contentType } = buildMultipartPage('<p>Test</p>')
    const boundary = contentType.split('boundary=')[1]
    expect(body.toString('utf-8')).toContain(`--${boundary}--`)
  })

  it('retries boundary generation on collision', () => {
    let callCount = 0
    const fakeBoundary = () => {
      callCount++
      if (callCount === 1) return 'COLLISION-BOUNDARY'
      return 'safe-boundary-' + callCount
    }
    const html = '<p>COLLISION-BOUNDARY content</p>'
    const { contentType } = buildMultipartPage(html, fakeBoundary)
    expect(contentType).not.toContain('COLLISION-BOUNDARY')
    expect(callCount).toBeGreaterThanOrEqual(2)
  })
})

// ===========================================================================
// formatNotebook
// ===========================================================================

describe('formatNotebook', () => {
  it('formats a full notebook response', () => {
    const result = formatNotebook({
      id: 'nb-1',
      displayName: 'My Notebook',
      isDefault: true,
      isShared: false,
      createdDateTime: '2026-01-01T00:00:00Z',
      lastModifiedDateTime: '2026-01-02T00:00:00Z',
      links: { oneNoteWebUrl: { href: 'https://onenote.com/nb1' } },
    })
    expect(result.id).toBe('nb-1')
    expect(result.displayName).toBe('My Notebook')
    expect(result.isDefault).toBe(true)
    expect(result.isShared).toBe(false)
    expect(result.webUrl).toBe('https://onenote.com/nb1')
  })

  it('degrades gracefully on null/undefined input', () => {
    const result = formatNotebook(null)
    expect(result.id).toBeNull()
    expect(result.displayName).toBeNull()
    expect(result.webUrl).toBeNull()
  })
})

// ===========================================================================
// formatSection
// ===========================================================================

describe('formatSection', () => {
  it('formats a section with its parent notebook', () => {
    const result = formatSection({
      id: 'sec-1',
      displayName: 'Section 1',
      isDefault: false,
      createdDateTime: '2026-01-01',
      lastModifiedDateTime: '2026-01-02',
      parentNotebook: { id: 'nb-1', displayName: 'My Notebook' },
    })
    expect(result.id).toBe('sec-1')
    expect(result.notebookId).toBe('nb-1')
    expect(result.notebookName).toBe('My Notebook')
  })

  it('degrades gracefully without parentNotebook', () => {
    const result = formatSection({ id: 'sec-1', displayName: 'S1' })
    expect(result.notebookId).toBeNull()
    expect(result.notebookName).toBeNull()
  })
})

// ===========================================================================
// formatSectionGroup
// ===========================================================================

describe('formatSectionGroup', () => {
  it('formats a section group with parent notebook', () => {
    const result = formatSectionGroup({
      id: 'sg-1',
      displayName: 'Group 1',
      parentNotebook: { id: 'nb-1', displayName: 'My Notebook' },
    })
    expect(result.id).toBe('sg-1')
    expect(result.notebookId).toBe('nb-1')
  })

  it('degrades gracefully on null input', () => {
    const result = formatSectionGroup(null)
    expect(result.id).toBeNull()
  })
})

// ===========================================================================
// formatPage
// ===========================================================================

describe('formatPage', () => {
  it('formats a page with its parent section', () => {
    const result = formatPage({
      id: 'page-1',
      title: 'My Page',
      createdDateTime: '2026-01-01',
      lastModifiedDateTime: '2026-01-02',
      level: 1,
      order: 0,
      links: { oneNoteWebUrl: { href: 'https://onenote.com/p1' } },
      parentSection: { id: 'sec-1', displayName: 'Section 1' },
    })
    expect(result.id).toBe('page-1')
    expect(result.title).toBe('My Page')
    expect(result.sectionId).toBe('sec-1')
    expect(result.sectionName).toBe('Section 1')
    expect(result.webUrl).toBe('https://onenote.com/p1')
  })

  it('degrades gracefully on null input', () => {
    const result = formatPage(null)
    expect(result.id).toBeNull()
    expect(result.title).toBeNull()
    expect(result.sectionId).toBeNull()
  })
})

// ===========================================================================
// pollOperation
// ===========================================================================

describe('pollOperation', () => {
  it('returns the operation when it completes', async () => {
    const mockGraphRequest: GraphRequestFn = async () => ({
      status: 'Completed',
      resourceLocation: 'https://graph.microsoft.com/v1.0/me/onenote/pages/new-page-id',
    })
    const result = await pollOperation(mockGraphRequest, 'https://graph.microsoft.com/operation/1')
    expect(result.status).toBe('Completed')
    expect(result.resourceLocation).toContain('new-page-id')
  })

  it('throws when the operation fails', async () => {
    const mockGraphRequest: GraphRequestFn = async () => ({
      status: 'Failed',
      error: { message: 'Permission denied' },
    })
    expect(
      pollOperation(mockGraphRequest, 'https://graph.microsoft.com/operation/2'),
    ).rejects.toThrow(/OneNote operation failed: Permission denied/)
  })

  it('polls until completed', async () => {
    let callCount = 0
    const mockGraphRequest: GraphRequestFn = async () => {
      callCount++
      if (callCount < 3) return { status: 'Running' }
      return { status: 'Completed' }
    }
    const result = await pollOperation(mockGraphRequest, 'https://graph.microsoft.com/operation/3')
    expect(result.status).toBe('Completed')
    expect(callCount).toBe(3)
  })
})
