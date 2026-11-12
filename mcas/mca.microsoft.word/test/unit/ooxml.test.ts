/**
 * Unit tests for OOXML pure functions.
 *
 * Ported from agentapps-private/test/microsoft-word.test.ts (OOXML section),
 * adapted from vitest to bun:test.
 *
 * These tests exercise the zip and XML handling for real — only the network
 * is mocked (and not needed here since these are pure functions).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import JSZip from 'jszip'
import {
  assertUsableDocx,
  bodyInsertionPoint,
  buildParagraphXml,
  buildPageBreakXml,
  buildTableXml,
  editDocxInPlace,
  escapeXmlText,
  insertParagraphsXml,
  openDocx,
  packDocx,
  paragraphRanges,
  readPart,
  removeParagraph,
  replaceInParagraph,
  replaceTextInDocument,
  setCoreProperty,
  unescapeXmlText,
  validateDocx,
  writePart,
  MAX_DOCX_BYTES,
} from '../../src/lib/ooxml'
import { listParagraphs, paragraphText } from '../../src/lib/read-docx'

const __dirname = dirname(fileURLToPath(import.meta.url))

function sampleDocx(): Buffer {
  return readFileSync(join(__dirname, '..', 'fixtures', 'sample.docx'))
}

function legacyDoc(): Buffer {
  return readFileSync(join(__dirname, '..', 'fixtures', 'legacy.doc'))
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** A fake graphRequest that returns the sample docx on GET and a stub on PUT. */
function fakeGraphRequest() {
  const calls: Array<{ method: string; path: string }> = []
  const fn = async (method: string, path: string) => {
    calls.push({ method, path })
    if (method === 'GET') return sampleDocx()
    return { id: 'i1' }
  }
  return { fn, calls }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('escapeXmlText', () => {
  it('strips control characters XML forbids outright', () => {
    expect(escapeXmlText('Page one\x0CPage two\x0B')).toBe('Page onePage two')
    expect(escapeXmlText('a\x00b\x1Fc')).toBe('abc')
  })

  it('escapes the three XML metacharacters', () => {
    expect(escapeXmlText('R&D <2026>')).toBe('R&amp;D &lt;2026&gt;')
  })
})

describe('unescapeXmlText', () => {
  it('decodes numeric character references', () => {
    expect(unescapeXmlText('caf&#233;')).toBe('café')
    expect(unescapeXmlText('caf&#xE9;')).toBe('café')
  })

  it('decodes the five predefined entities', () => {
    expect(unescapeXmlText('R&amp;D &lt;2026&gt;')).toBe('R&D <2026>')
  })
})

describe('assertUsableDocx', () => {
  it('refuses a legacy .doc by its magic bytes, not just its name', () => {
    expect(() => assertUsableDocx(legacyDoc())).toThrow(/legacy/i)
    expect(() => assertUsableDocx(sampleDocx())).not.toThrow()
  })

  it('refuses a file above the in-memory ceiling', () => {
    const huge = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(MAX_DOCX_BYTES),
    ])
    expect(() => assertUsableDocx(huge)).toThrow(/50 MB|too large/i)
  })
})

describe('openDocx', () => {
  it('refuses a corrupt archive with a real message', async () => {
    const corrupt = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('garbage')])
    await expect(openDocx(corrupt)).rejects.toThrow(/could not be opened|corrupt|password/i)
  })
})

describe('Fidelity — preserving unmodified entries', () => {
  it('preserves every unmodified entry when one part is rewritten', async () => {
    const original = sampleDocx()
    const before = await openDocx(original)
    const beforeNames = Object.keys(before.files).sort()

    const zip = await openDocx(original)
    const doc = await readPart(zip, 'word/document.xml')
    writePart(zip, 'word/document.xml', doc.replace('12 percent', '15 percent'))
    const rebuilt = await packDocx(zip)

    const after = await openDocx(rebuilt)
    expect(Object.keys(after.files).sort()).toEqual(beforeNames)

    for (const name of beforeNames) {
      if (name === 'word/document.xml') continue
      const a = await before.file(name)!.async('nodebuffer')
      const b = await after.file(name)!.async('nodebuffer')
      expect(a.equals(b), `${name} was modified`).toBe(true)
    }

    expect(await readPart(after, 'word/document.xml')).toContain('15 percent')
  })
})

describe('validateDocx', () => {
  it('rejects an archive missing a required part', async () => {
    const zip = await openDocx(sampleDocx())
    zip.remove('word/document.xml')
    await expect(validateDocx(await packDocx(zip))).rejects.toThrow(/word\/document\.xml/)
  })

  it('passes on a valid archive', async () => {
    await expect(validateDocx(await packDocx(await openDocx(sampleDocx())))).resolves.toBeUndefined()
  })

  it('rejects a document.xml that no longer parses', async () => {
    const zip = await openDocx(sampleDocx())
    writePart(zip, 'word/document.xml', '<w:document><w:body><w:p></w:document>')
    await expect(validateDocx(await packDocx(zip))).rejects.toThrow(/parse|malformed|invalid/i)
  })

  it('rejects an unbalanced paragraph count', async () => {
    const zip = await openDocx(sampleDocx())
    writePart(
      zip,
      'word/document.xml',
      '<w:document><w:body><w:p><w:r><w:t>Unclosed</w:t></w:r></w:body></w:document>',
    )
    await expect(validateDocx(await packDocx(zip))).rejects.toThrow(/1 paragraph opens against 0 closes/)
  })

  it('rejects a document.xml containing a raw control character', async () => {
    const zip = await openDocx(sampleDocx())
    const doc = await readPart(zip, 'word/document.xml')
    writePart(zip, 'word/document.xml', doc.replace('Quarterly Report', 'Quarterly\x0CReport'))
    await expect(validateDocx(await packDocx(zip))).rejects.toThrow(/U\+000C/)
  })
})

describe('paragraphRanges', () => {
  it('counts top-level paragraphs, including empty and nested ones', async () => {
    const doc = await readPart(await openDocx(sampleDocx()), 'word/document.xml')
    // The fixture has four: heading, revenue, the split-run one, and an empty self-closing <w:p/>.
    expect(paragraphRanges(doc)).toHaveLength(4)
  })

  it('does not truncate a paragraph containing a text box', () => {
    const nested =
      '<w:body><w:p><w:r><w:t>Outer</w:t></w:r><w:txbxContent><w:p><w:r><w:t>Inside</w:t></w:r></w:p></w:txbxContent><w:r><w:t> tail</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body>'
    const ranges = paragraphRanges(nested)
    expect(ranges).toHaveLength(2)
    const first = nested.slice(ranges[0].start, ranges[0].end)
    expect(first).toContain('Inside')
    expect(first).toContain(' tail')
  })

  it('does not index paragraphs inside a table', () => {
    const doc =
      '<w:body>' +
      '<w:p><w:r><w:t>Before</w:t></w:r></w:p>' +
      '<w:tbl><w:tr>' +
      '<w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc>' +
      '<w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc>' +
      '</w:tr></w:tbl>' +
      '<w:p><w:r><w:t>After</w:t></w:r></w:p>' +
      '<w:sectPr><w:pgSz w:w="1" w:h="2"/></w:sectPr>' +
      '</w:body>'
    expect(listParagraphs(doc).map((p) => p.text)).toEqual(['Before', 'After'])
  })
})

describe('replaceInParagraph', () => {
  it('handles every run-splitting shape', () => {
    const split =
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hel</w:t></w:r><w:r><w:t xml:space="preserve">lo wo</w:t></w:r><w:r><w:t>rld</w:t></w:r></w:p>'

    const cases: Array<[string, string, string, string, string, number]> = [
      ['across three runs', split, 'Hello world', 'Goodbye moon', 'Goodbye moon', 1],
      ['two matches in one run', '<w:p><w:r><w:t>a &amp; b and a &amp; b</w:t></w:r></w:p>', 'a & b', 'X', 'X and X', 2],
      ['two matches each spanning runs', '<w:p><w:r><w:t>foo</w:t></w:r><w:r><w:t>bar foo</w:t></w:r><w:r><w:t>bar</w:t></w:r></w:p>', 'foobar', 'Z', 'Z Z', 2],
      ['no match leaves it alone', '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>', 'zzz', 'X', 'Hello', 0],
      ['replacement containing an ampersand is re-escaped', '<w:p><w:r><w:t>Tom and Jerry</w:t></w:r></w:p>', 'and', '&', 'Tom & Jerry', 1],
      ['empty replacement deletes', '<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>', ' world', '', 'Hello', 1],
      ['adjacent matches', '<w:p><w:r><w:t>abab</w:t></w:r></w:p>', 'ab', 'X', 'XX', 2],
    ]

    for (const [name, xml, search, replacement, expectedText, expectedCount] of cases) {
      const result = replaceInParagraph(xml, search, replacement)
      expect(paragraphText(result.xml), name).toBe(expectedText)
      expect(result.count, name).toBe(expectedCount)
    }
  })

  it("preserves each run's formatting", () => {
    const split =
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hel</w:t></w:r><w:r><w:t xml:space="preserve">lo wo</w:t></w:r><w:r><w:t>rld</w:t></w:r></w:p>'
    const { xml } = replaceInParagraph(split, 'Hello world', 'Goodbye moon')
    expect(xml).toContain('<w:rPr><w:b/></w:rPr>')
    expect(xml).toContain('xml:space="preserve"')
  })
})

describe('replaceTextInDocument', () => {
  it('replaces every match regardless of paragraph position', () => {
    const doc =
      '<w:body>' +
      '<w:p><w:r><w:t>alpha needle omega</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>beta needle sigma</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>gamma needle tau</w:t></w:r></w:p>' +
      '</w:body>'
    const replacement = 'R'.repeat(50)
    const result = replaceTextInDocument(doc, 'needle', replacement)
    expect(result.count).toBe(3)
    expect(paragraphRanges(result.xml)).toHaveLength(3)
    const texts = paragraphRanges(result.xml).map((r) =>
      paragraphText(result.xml.slice(r.start, r.end)),
    )
    expect(texts).toEqual([
      `alpha ${replacement} omega`,
      `beta ${replacement} sigma`,
      `gamma ${replacement} tau`,
    ])
  })
})

describe('bodyInsertionPoint', () => {
  it('finds the body-level section properties, not a tracked-change copy', () => {
    const tracked =
      '<w:body>' +
      '<w:p><w:r><w:t>Body</w:t></w:r></w:p>' +
      '<w:sectPr>' +
      '<w:pgSz w:w="12240" w:h="15840"/>' +
      '<w:sectPrChange w:id="1" w:author="Ana"><w:sectPr><w:pgSz w:w="15840" w:h="12240"/></w:sectPr></w:sectPrChange>' +
      '</w:sectPr>' +
      '</w:body>'
    expect(bodyInsertionPoint(tracked)).toBe(tracked.indexOf('<w:sectPr>'))

    const spliced = insertParagraphsXml(tracked, buildParagraphXml('Appended'))
    expect(spliced.indexOf('Appended')).toBeLessThan(spliced.indexOf('<w:sectPr>'))
  })

  it('handles a multi-section document with pPr-nested sectPr', () => {
    const multi =
      '<w:body><w:p><w:pPr><w:sectPr><w:pgSz w:w="1" w:h="2"/></w:sectPr></w:pPr></w:p>' +
      '<w:p/><w:sectPr><w:pgSz w:w="3" w:h="4"/></w:sectPr></w:body>'
    expect(bodyInsertionPoint(multi)).toBe(multi.lastIndexOf('<w:sectPr>'))
  })

  it('handles a self-closing sectPr', () => {
    const selfClosing =
      '<w:body><w:p><w:pPr><w:sectPr/></w:pPr></w:p>' +
      '<w:p><w:r><w:t>Body</w:t></w:r></w:p>' +
      '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body>'
    expect(bodyInsertionPoint(selfClosing)).toBe(selfClosing.lastIndexOf('<w:sectPr>'))
  })

  it('falls back to the end of the body when only pPr-nested sectPr exists', () => {
    const onlyPPrNested =
      '<w:body><w:p><w:pPr><w:sectPr><w:pgSz w:w="1" w:h="2"/></w:sectPr></w:pPr></w:p></w:body>'
    expect(bodyInsertionPoint(onlyPPrNested)).toBe(onlyPPrNested.lastIndexOf('</w:body>'))
  })
})

describe('buildParagraphXml', () => {
  it('produces a paragraph with escaped text', () => {
    const xml = buildParagraphXml('R&D <2026>')
    expect(xml).toContain('&amp;D &lt;2026&gt;')
    expect(xml).toContain('<w:t xml:space="preserve">')
  })

  it('adds a heading style when given', () => {
    const xml = buildParagraphXml('Title', 'Heading1')
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>')
  })
})

describe('buildTableXml', () => {
  it('produces a bordered table with escaped cell text', () => {
    const xml = buildTableXml([['A&B', 'C<D'], ['1', '2']], true)
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('&amp;B')
    expect(xml).toContain('&lt;D')
    expect(xml).toContain('<w:b/>') // header row bold
  })
})

describe('buildPageBreakXml', () => {
  it('produces a page break paragraph', () => {
    expect(buildPageBreakXml()).toContain('<w:br w:type="page"/>')
  })
})

describe('removeParagraph', () => {
  it('removes exactly the specified index', async () => {
    const doc = await readPart(await openDocx(sampleDocx()), 'word/document.xml')
    const before = listParagraphs(doc)
    const modified = removeParagraph(doc, 1)
    const after = listParagraphs(modified)
    expect(after).toHaveLength(before.length - 1)
    expect(after.map((p) => p.text)).not.toContain('Revenue grew by 12 percent.')
    expect(after[0].text).toBe('Quarterly Report')
    expect(after[1].text).toBe('Hello world')
  })

  it('rejects an out-of-range index', async () => {
    const doc = await readPart(await openDocx(sampleDocx()), 'word/document.xml')
    expect(() => removeParagraph(doc, 99)).toThrow(/4 paragraphs|does not exist/)
  })
})

describe('setCoreProperty', () => {
  it('replaces a self-closing property instead of duplicating it', () => {
    const start =
      '<cp:coreProperties xmlns:cp="c" xmlns:dc="d"><dc:title/><dc:creator>Bob</dc:creator></cp:coreProperties>'
    const once = setCoreProperty(start, 'dc:title', 'New Title')
    expect(once).toContain('<dc:title>New Title</dc:title>')
    expect(once).not.toContain('<dc:title/>')
    expect(once).toContain('<dc:creator>Bob</dc:creator>')
    // Genuinely idempotent
    expect(setCoreProperty(once, 'dc:title', 'New Title')).toBe(once)
  })

  it('refuses a core.xml it cannot append to', () => {
    expect(() => setCoreProperty('<somethingElse/>', 'dc:title', 'X')).toThrow(/coreProperties/)
  })
})

describe('editDocxInPlace', () => {
  it('downloads, mutates, validates, and uploads', async () => {
    const { fn, calls } = fakeGraphRequest()
    const result = await editDocxInPlace(fn as any, '/me/drive/items/i1', async (zip) => {
      const doc = await readPart(zip, 'word/document.xml')
      writePart(zip, 'word/document.xml', doc.replace('12 percent', '15 percent'))
    })
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT'])
    expect(calls[0].path).toBe('/me/drive/items/i1/content')
    expect(calls[1].path).toBe('/me/drive/items/i1/content')
    expect(result.uploadedBytes).toBeGreaterThan(0)
  })

  it('uploads nothing when the mutation produces an invalid archive', async () => {
    let uploaded = false
    const spy = (async (method: string, _path: string) => {
      if (method === 'PUT') uploaded = true
      return method === 'GET' ? sampleDocx() : { id: 'i1' }
    }) as any
    await expect(
      editDocxInPlace(spy, '/me/drive/items/i1', (zip) => {
        zip.remove('word/document.xml')
      }),
    ).rejects.toThrow(/word\/document\.xml/)
    expect(uploaded).toBe(false)
  })
})

describe('Fixture integrity', () => {
  it('ships a sample.docx that is a real, structurally complete archive', async () => {
    const zip = await JSZip.loadAsync(sampleDocx())
    const names = Object.keys(zip.files).sort()
    expect(names).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/app.xml',
      'docProps/core.xml',
      'word/_rels/document.xml.rels',
      'word/document.xml',
      'word/styles.xml',
    ])
    const doc = await zip.file('word/document.xml')!.async('string')
    // Paragraph 3 splits "Hello world" across 3 runs
    expect(doc).toContain('<w:t xml:space="preserve">Hel</w:t>')
    expect(doc).toContain('<w:t xml:space="preserve">lo wo</w:t>')
    expect(doc).toContain('<w:t>rld</w:t>')
    expect(doc).not.toContain('<w:t>Hello world</w:t>')
    expect(doc).toContain('<w:rPr><w:b/></w:rPr>')
  })

  it('ships a legacy.doc with a real OLE2 signature', async () => {
    const bytes = legacyDoc()
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    )
    await expect(JSZip.loadAsync(bytes)).rejects.toThrow()
  })
})
