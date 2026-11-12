/**
 * Unit tests for Word tool handlers.
 *
 * Ported from agentapps-private/test/microsoft-word.test.ts (tool section),
 * adapted from vitest + agentapps protocol to bun:test with mocked fetch.
 *
 * Strategy: mock globalThis.fetch to intercept Graph API calls, then call
 * tool handlers directly with a fake context. The sample.docx fixture is
 * returned for GET content requests so the OOXML logic runs for real.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function sampleDocx(): Buffer {
  return readFileSync(join(__dirname, '..', 'fixtures', 'sample.docx'))
}

const realFetch = globalThis.fetch

let fetchCalls: Array<{ url: string; method: string; body?: string }> = []
let nextResponse: () => Response = () =>
  new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })

beforeAll(() => {
  globalThis.fetch = (async (url: any, init: any) => {
    fetchCalls.push({
      url: String(url),
      method: init?.method || 'GET',
      body: init?.body ? String(init.body).slice(0, 200) : undefined,
    })
    return nextResponse()
  }) as typeof fetch
})

afterEach(() => {
  fetchCalls = []
  nextResponse = () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
})

afterAll(() => {
  globalThis.fetch = realFetch
})

// ─── Fake context ───────────────────────────────────────────────────────────

const SYSTEM_SECRETS = {
  CLIENT_ID: 'test-client-id',
  CLIENT_SECRET: 'test-client-secret',
  REDIRECT_URIS: '["http://localhost/callback"]',
}
const USER_SECRETS = {
  ACCESS_TOKEN: 'test-access-token',
  REFRESH_TOKEN: 'test-refresh-token',
  EMAIL: 'test@teros.ai',
  EXPIRY_DATE: new Date(Date.now() + 3600_000).toISOString(),
}

// biome-ignore lint/suspicious/noExplicitAny: context fake
function makeContext(): any {
  return {
    getSystemSecrets: async () => SYSTEM_SECRETS,
    getUserSecrets: async () => USER_SECRETS,
    updateUserSecrets: async () => {},
  }
}

// ─── Response helpers ───────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bufferResponse(bytes: Buffer, status = 200) {
  return new Response(bytes, {
    status,
    headers: { 'content-type': 'application/octet-stream' },
  })
}

function noContentResponse() {
  return new Response(null, { status: 204 })
}

function setResponseSequence(...responses: Response[]) {
  let i = 0
  nextResponse = () => responses[i++] || responses[responses.length - 1]
}

// ─── Import tools after mock is set up ──────────────────────────────────────

const {
  createDocument,
  readDocument,
  getDocumentInfo,
  listParagraphs,
  getComments,
  replaceText,
  appendParagraphs,
  deleteParagraph,
  insertTable,
  insertPageBreak,
  insertImage,
  updateDocumentProperties,
  convertToPdf,
} = await import('../../src/tools')

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Word tool handlers', () => {
  // =========================================================================
  // CREATE-DOCUMENT
  // =========================================================================

  describe('create-document', () => {
    it('uploads a new .docx to the requested path', async () => {
      setResponseSequence(
        jsonResponse({ id: 'item1', name: 'Report.docx', size: 1526, webUrl: 'https://...' }),
      )
      const result = await createDocument.handler!(
        { path: 'Report.docx', paragraphs: [{ text: 'Hello world' }] } as any,
        makeContext(),
      )
      expect((result as any).success).toBe(true)
      expect((result as any).item.id).toBe('item1')
      expect((result as any).paragraphsWritten).toBe(1)
      expect(fetchCalls[0].method).toBe('PUT')
      expect(fetchCalls[0].url).toContain('/me/drive/root:/Report.docx:/content')
      expect(fetchCalls[0].url).toContain('conflictBehavior=fail')
    })

    it('uses conflictBehavior=replace when overwrite is set', async () => {
      setResponseSequence(jsonResponse({ id: 'item1' }))
      await createDocument.handler!(
        { path: 'Report.docx', paragraphs: [{ text: 'Hello' }], overwrite: true } as any,
        makeContext(),
      )
      expect(fetchCalls[0].url).toContain('conflictBehavior=replace')
    })

    it('rejects a non-.docx path', async () => {
      await expect(
        createDocument.handler!(
          { path: 'report.txt', paragraphs: [{ text: 'Hello' }] } as any,
          makeContext(),
        ),
      ).rejects.toThrow(/not one.*\.docx|legacy/)
    })

    it('rejects a path without .docx extension', async () => {
      await expect(
        createDocument.handler!(
          { path: 'Report', paragraphs: [{ text: 'Hello' }] } as any,
          makeContext(),
        ),
      ).rejects.toThrow(/not one.*\.docx|legacy/)
    })
  })

  // =========================================================================
  // READ-DOCUMENT
  // =========================================================================

  describe('read-document', () => {
    it('returns markdown by default', async () => {
      setResponseSequence(bufferResponse(sampleDocx()))
      const result = await readDocument.handler!(
        { itemId: 'item1' } as any,
        makeContext(),
      )
      expect((result as any).format).toBe('markdown')
      expect((result as any).content).toContain('Quarterly Report')
      expect(fetchCalls[0].method).toBe('GET')
      expect(fetchCalls[0].url).toContain('/me/drive/items/item1/content')
    })

    it('returns HTML when format=html', async () => {
      setResponseSequence(bufferResponse(sampleDocx()))
      const result = await readDocument.handler!(
        { itemId: 'item1', format: 'html' } as any,
        makeContext(),
      )
      expect((result as any).format).toBe('html')
      expect((result as any).content).toContain('Quarterly Report')
    })

    it('resolves by path', async () => {
      setResponseSequence(bufferResponse(sampleDocx()))
      await readDocument.handler!(
        { path: 'Reports/Q3.docx' } as any,
        makeContext(),
      )
      expect(fetchCalls[0].url).toContain('/me/drive/root:/Reports/Q3.docx:/content')
    })
  })

  // =========================================================================
  // LIST-PARAGRAPHS
  // =========================================================================

  describe('list-paragraphs', () => {
    it('returns paragraphs with indices', async () => {
      setResponseSequence(bufferResponse(sampleDocx()))
      const result = await listParagraphs.handler!(
        { itemId: 'item1' } as any,
        makeContext(),
      )
      const paragraphs = (result as any).paragraphs
      expect((result as any).count).toBe(4)
      expect(paragraphs[0].text).toBe('Quarterly Report')
      expect(paragraphs[1].text).toBe('Revenue grew by 12 percent.')
      expect(paragraphs[2].text).toBe('Hello world')
      expect(paragraphs[3].empty).toBe(true)
    })
  })

  // =========================================================================
  // REPLACE-TEXT
  // =========================================================================

  describe('replace-text', () => {
    it('replaces text across run boundaries and uploads', async () => {
      // replace-text peeks with a GET, then editDocxInPlace does GET + PUT = 3 fetch calls
      setResponseSequence(
        bufferResponse(sampleDocx()), // peek GET
        bufferResponse(sampleDocx()), // editDocxInPlace GET
        jsonResponse({ id: 'item1', name: 'sample.docx' }), // editDocxInPlace PUT
      )
      const result = await replaceText.handler!(
        { itemId: 'item1', search: 'Hello world', replacement: 'Goodbye moon' } as any,
        makeContext(),
      )
      expect((result as any).success).toBe(true)
      expect((result as any).replacements).toBe(1)
      expect(fetchCalls[0].method).toBe('GET')
      expect(fetchCalls[2].method).toBe('PUT')
    })

    it('rejects an empty search string', async () => {
      await expect(
        replaceText.handler!(
          { itemId: 'item1', search: '', replacement: 'X' } as any,
          makeContext(),
        ),
      ).rejects.toThrow(/search/)
    })

    it('reports zero replacements when nothing matches', async () => {
      // peek GET only — the tool returns early without uploading when count=0
      setResponseSequence(
        bufferResponse(sampleDocx()),
      )
      const result = await replaceText.handler!(
        { itemId: 'item1', search: 'nonexistent text', replacement: 'X' } as any,
        makeContext(),
      )
      expect((result as any).replacements).toBe(0)
    })
  })

  // =========================================================================
  // DELETE-PARAGRAPH
  // =========================================================================

  describe('delete-paragraph', () => {
    it('deletes a paragraph by index and uploads', async () => {
      setResponseSequence(
        bufferResponse(sampleDocx()),
        jsonResponse({ id: 'item1' }),
      )
      const result = await deleteParagraph.handler!(
        { itemId: 'item1', paragraphIndex: 1 } as any,
        makeContext(),
      )
      expect((result as any).success).toBe(true)
      expect((result as any).deletedIndex).toBe(1)
      expect((result as any).uploadedBytes).toBeGreaterThan(0)
    })

    it('rejects a non-integer paragraphIndex', async () => {
      await expect(
        deleteParagraph.handler!(
          { itemId: 'item1', paragraphIndex: 1.5 } as any,
          makeContext(),
        ),
      ).rejects.toThrow(/paragraphIndex/)
    })

    it('rejects a missing paragraphIndex', async () => {
      await expect(
        deleteParagraph.handler!(
          { itemId: 'item1' } as any,
          makeContext(),
        ),
      ).rejects.toThrow(/paragraphIndex/)
    })
  })

  // =========================================================================
  // APPEND-PARAGRAPHS
  // =========================================================================

  describe('append-paragraphs', () => {
    it('appends paragraphs and uploads', async () => {
      setResponseSequence(
        bufferResponse(sampleDocx()),
        jsonResponse({ id: 'item1' }),
      )
      const result = await appendParagraphs.handler!(
        { itemId: 'item1', paragraphs: [{ text: 'New paragraph' }, { text: 'Second', style: 'Heading1' }] } as any,
        makeContext(),
      )
      expect((result as any).success).toBe(true)
      expect((result as any).paragraphsAppended).toBe(2)
    })

    it('rejects an empty paragraphs array', async () => {
      await expect(
        appendParagraphs.handler!(
          { itemId: 'item1', paragraphs: [] } as any,
          makeContext(),
        ),
      ).rejects.toThrow(/paragraphs/)
    })
  })

  // =========================================================================
  // INSERT-TABLE
  // =========================================================================

  describe('insert-table', () => {
    it('inserts a table and uploads', async () => {
      setResponseSequence(
        bufferResponse(sampleDocx()),
        jsonResponse({ id: 'item1' }),
      )
      const result = await insertTable.handler!(
        { itemId: 'item1', rows: [['A', 'B'], ['1', '2']], headerRow: true } as any,
        makeContext(),
      )
      expect((result as any).success).toBe(true)
    })
  })

  // =========================================================================
  // INSERT-PAGE-BREAK
  // =========================================================================

  describe('insert-page-break', () => {
    it('inserts a page break and uploads', async () => {
      setResponseSequence(
        bufferResponse(sampleDocx()),
        jsonResponse({ id: 'item1' }),
      )
      const result = await insertPageBreak.handler!(
        { itemId: 'item1' } as any,
        makeContext(),
      )
      expect((result as any).success).toBe(true)
    })
  })

  // =========================================================================
  // INSERT-IMAGE
  // =========================================================================

  describe('insert-image', () => {
    it('rejects a non-PNG/JPEG image', async () => {
      // editDocxInPlace: GET (download docx) → mutate (imageContentType throws) → no PUT
      setResponseSequence(
        bufferResponse(sampleDocx()),
      )
      const fakeBytes = Buffer.from('not an image')
      await expect(
        insertImage.handler!(
          { itemId: 'item1', fileName: 'pic.png', imageBase64: fakeBytes.toString('base64') } as any,
          makeContext(),
        ),
      ).rejects.toThrow(/PNG or JPEG|neither/)
    })
  })

  // =========================================================================
  // GET-DOCUMENT-INFO
  // =========================================================================

  describe('get-document-info', () => {
    it('returns item metadata', async () => {
      setResponseSequence(
        jsonResponse({
          id: 'item1',
          name: 'Report.docx',
          size: 1526,
          createdDateTime: '2026-01-01T00:00:00Z',
          lastModifiedDateTime: '2026-09-01T00:00:00Z',
          webUrl: 'https://1drv.ms/w/abc',
        }),
        bufferResponse(sampleDocx()),
      )
      const result = await getDocumentInfo.handler!(
        { itemId: 'item1' } as any,
        makeContext(),
      )
      expect((result as any).item.id).toBe('item1')
      expect((result as any).item.name).toBe('Report.docx')
      expect((result as any).paragraphCount).toBe(4)
    })
  })

  // =========================================================================
  // GET-COMMENTS
  // =========================================================================

  describe('get-comments', () => {
    it('returns an empty list when the document has no comments', async () => {
      setResponseSequence(bufferResponse(sampleDocx()))
      const result = await getComments.handler!(
        { itemId: 'item1' } as any,
        makeContext(),
      )
      expect((result as any).comments).toEqual([])
    })
  })

  // =========================================================================
  // UPDATE-DOCUMENT-PROPERTIES
  // =========================================================================

  describe('update-document-properties', () => {
    it('updates the title and uploads', async () => {
      setResponseSequence(
        bufferResponse(sampleDocx()),
        jsonResponse({ id: 'item1' }),
      )
      const result = await updateDocumentProperties.handler!(
        { itemId: 'item1', title: 'New Title' } as any,
        makeContext(),
      )
      expect((result as any).success).toBe(true)
    })
  })

  // =========================================================================
  // CONVERT-TO-PDF
  // =========================================================================

  describe('convert-to-pdf', () => {
    it('requests a PDF conversion and saves it to OneDrive', async () => {
      // GET (pdf content) → PUT (save to destination)
      setResponseSequence(
        bufferResponse(Buffer.from('%PDF-1.4 fake pdf')),
        jsonResponse({ id: 'pdf1', name: 'Report.pdf', size: 1000 }),
      )
      const result = await convertToPdf.handler!(
        { itemId: 'item1', destinationPath: 'Report.pdf' } as any,
        makeContext(),
      )
      expect((result as any).success).toBe(true)
      expect((result as any).destinationPath).toBe('Report.pdf')
      expect((result as any).pdfBytes).toBeGreaterThan(0)
    })

    it('derives destination from source path when not specified', async () => {
      setResponseSequence(
        bufferResponse(Buffer.from('%PDF-1.4 fake pdf')),
        jsonResponse({ id: 'pdf1' }),
      )
      const result = await convertToPdf.handler!(
        { path: 'Reports/Q3.docx' } as any,
        makeContext(),
      )
      expect((result as any).destinationPath).toBe('Reports/Q3.pdf')
    })

    it('requires destinationPath when only itemId is given', async () => {
      await expect(
        convertToPdf.handler!(
          { itemId: 'item1' } as any,
          makeContext(),
        ),
      ).rejects.toThrow(/destinationPath/)
    })
  })

  // =========================================================================
  // ARGUMENT VALIDATION
  // =========================================================================

  describe('argument validation', () => {
    it('rejects when neither itemId nor path is supplied', async () => {
      await expect(
        readDocument.handler!({} as any, makeContext()),
      ).rejects.toThrow(/itemId or path/)
    })
  })
})
