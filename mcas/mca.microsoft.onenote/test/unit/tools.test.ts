/**
 * Unit tests for OneNote tool handlers.
 *
 * Ported from agentapps-private/test/microsoft-onenote.test.ts (tool section),
 * adapted from vitest + agentapps protocol to bun:test with mocked fetch.
 *
 * Strategy: mock globalThis.fetch to intercept Graph API calls, then call
 * tool handlers directly with a fake context.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'

const realFetch = globalThis.fetch

// Track all fetch calls for assertions
let fetchCalls: Array<{ url: string; method: string; body?: string }> = []
let nextResponse: () => Response = () =>
  new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })

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
  nextResponse = () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function noContentResponse() {
  return new Response(null, { status: 204 })
}

function textResponse(text: string, status = 200) {
  return new Response(text, { status, headers: { 'content-type': 'text/html' } })
}

/** Sets up a sequence of responses for sequential fetch calls. */
function setResponseSequence(...responses: Response[]) {
  let i = 0
  nextResponse = () => responses[i++] || responses[responses.length - 1]!
}

// Import tools after mock is set up
const {
  listNotebooks,
  getNotebook,
  createNotebook,
  listSections,
  createSection,
  listSectionGroups,
  listPages,
  getPage,
  getPageContent,
  createPage,
  deletePage,
  appendToPage,
  replacePageContent,
  searchPages,
} = await import('../../src/tools')

describe('OneNote tool handlers', () => {
  // ===========================================================================
  // NOTEBOOKS
  // ===========================================================================

  describe('list-notebooks', () => {
    it('returns formatted notebooks', async () => {
      setResponseSequence(
        jsonResponse({
          value: [
            { id: 'nb-1', displayName: 'Personal', isDefault: true, isShared: false },
            { id: 'nb-2', displayName: 'Work', isDefault: false, isShared: true },
          ],
        }),
      )
      const result = await listNotebooks.handler!({} as any, makeContext())
      expect((result as any).count).toBe(2)
      expect((result as any).notebooks[0].displayName).toBe('Personal')
      expect((result as any).notebooks[1].isShared).toBe(true)
      expect(fetchCalls[0].method).toBe('GET')
      expect(fetchCalls[0].url).toContain('/me/onenote/notebooks')
    })
  })

  describe('get-notebook', () => {
    it('returns a single notebook by id', async () => {
      setResponseSequence(
        jsonResponse({ id: 'nb-1', displayName: 'Personal', isDefault: true }),
      )
      const result = await getNotebook.handler!({ notebookId: 'nb-1' } as any, makeContext())
      expect((result as any).notebook.id).toBe('nb-1')
      expect(fetchCalls[0].url).toContain('/me/onenote/notebooks/nb-1')
    })

    it('rejects a missing notebookId', async () => {
      expect(getNotebook.handler!({} as any, makeContext())).rejects.toThrow(/Specify notebookId/)
    })
  })

  describe('create-notebook', () => {
    it('posts the displayName', async () => {
      setResponseSequence(jsonResponse({ id: 'nb-3', displayName: 'New Notebook' }))
      const result = await createNotebook.handler!({ displayName: 'New Notebook' } as any, makeContext())
      expect((result as any).success).toBe(true)
      expect((result as any).notebook.displayName).toBe('New Notebook')
      expect(fetchCalls[0].method).toBe('POST')
      expect(JSON.parse(fetchCalls[0].body!).displayName).toBe('New Notebook')
    })

    it('rejects a missing name', async () => {
      expect(createNotebook.handler!({} as any, makeContext())).rejects.toThrow(/non-empty name/)
    })

    it('rejects a name with disallowed characters', async () => {
      expect(
        createNotebook.handler!({ displayName: 'bad?name' } as any, makeContext()),
      ).rejects.toThrow(/does not allow/)
    })
  })

  // ===========================================================================
  // SECTIONS
  // ===========================================================================

  describe('list-sections', () => {
    it('lists sections scoped to a notebook', async () => {
      setResponseSequence(
        jsonResponse({
          value: [
            { id: 'sec-1', displayName: 'Notes', parentNotebook: { id: 'nb-1', displayName: 'Personal' } },
          ],
        }),
      )
      const result = await listSections.handler!({ notebookId: 'nb-1' } as any, makeContext())
      expect((result as any).count).toBe(1)
      expect((result as any).sections[0].displayName).toBe('Notes')
      expect((result as any).sections[0].notebookId).toBe('nb-1')
      expect(fetchCalls[0].url).toContain('/me/onenote/notebooks/nb-1/sections')
    })

    it('lists all sections when notebookId is omitted', async () => {
      setResponseSequence(jsonResponse({ value: [] }))
      await listSections.handler!({} as any, makeContext())
      expect(fetchCalls[0].url).toContain('/me/onenote/sections')
      expect(fetchCalls[0].url).not.toContain('notebooks')
    })
  })

  describe('create-section', () => {
    it('posts the section name to the notebook', async () => {
      setResponseSequence(
        jsonResponse({ id: 'sec-2', displayName: 'New Section', parentNotebook: { id: 'nb-1' } }),
      )
      const result = await createSection.handler!({
        parentNotebookId: 'nb-1',
        displayName: 'New Section',
      } as any, makeContext())
      expect((result as any).success).toBe(true)
      expect((result as any).section.displayName).toBe('New Section')
      expect(fetchCalls[0].method).toBe('POST')
      expect(fetchCalls[0].url).toContain('/me/onenote/notebooks/nb-1/sections')
    })

    it('accepts notebookId as an alias for parentNotebookId', async () => {
      setResponseSequence(jsonResponse({ id: 'sec-3', displayName: 'S' }))
      await createSection.handler!({ notebookId: 'nb-1', displayName: 'S' } as any, makeContext())
      expect(fetchCalls[0].url).toContain('/notebooks/nb-1/sections')
    })

    it('rejects a missing notebook id', async () => {
      expect(
        createSection.handler!({ displayName: 'S' } as any, makeContext()),
      ).rejects.toThrow(/Specify parentNotebookId or notebookId/)
    })
  })

  describe('list-section-groups', () => {
    it('lists section groups scoped to a notebook', async () => {
      setResponseSequence(
        jsonResponse({
          value: [{ id: 'sg-1', displayName: 'Group 1', parentNotebook: { id: 'nb-1' } }],
        }),
      )
      const result = await listSectionGroups.handler!({ notebookId: 'nb-1' } as any, makeContext())
      expect((result as any).count).toBe(1)
      expect((result as any).sectionGroups[0].displayName).toBe('Group 1')
    })
  })

  // ===========================================================================
  // PAGES
  // ===========================================================================

  describe('list-pages', () => {
    it('lists pages scoped to a section', async () => {
      setResponseSequence(
        jsonResponse({
          value: [
            { id: 'p-1', title: 'Page 1', parentSection: { id: 'sec-1', displayName: 'Notes' } },
          ],
        }),
      )
      const result = await listPages.handler!({ sectionId: 'sec-1' } as any, makeContext())
      expect((result as any).count).toBe(1)
      expect((result as any).pages[0].title).toBe('Page 1')
      expect(fetchCalls[0].url).toContain('/me/onenote/sections/sec-1/pages')
    })

    it('lists pages across all notebooks when sectionId is omitted', async () => {
      setResponseSequence(jsonResponse({ value: [] }))
      await listPages.handler!({} as any, makeContext())
      expect(fetchCalls[0].url).toContain('/me/onenote/pages')
    })

    it('caps top at 100', async () => {
      setResponseSequence(jsonResponse({ value: [] }))
      await listPages.handler!({ top: 500 } as any, makeContext())
      expect(fetchCalls[0].url).toMatch(/\$top=100/)
    })

    it('defaults top to 50', async () => {
      setResponseSequence(jsonResponse({ value: [] }))
      await listPages.handler!({} as any, makeContext())
      expect(fetchCalls[0].url).toMatch(/\$top=50/)
    })
  })

  describe('get-page', () => {
    it('returns page metadata by id', async () => {
      setResponseSequence(
        jsonResponse({
          id: 'p-1',
          title: 'My Page',
          parentSection: { id: 'sec-1', displayName: 'Notes' },
        }),
      )
      const result = await getPage.handler!({ pageId: 'p-1' } as any, makeContext())
      expect((result as any).page.title).toBe('My Page')
      expect((result as any).page.sectionId).toBe('sec-1')
    })

    it('rejects a missing pageId', async () => {
      expect(getPage.handler!({} as any, makeContext())).rejects.toThrow(/Specify pageId/)
    })
  })

  describe('get-page-content', () => {
    it('returns markdown by default', async () => {
      setResponseSequence(textResponse('<h1>Title</h1><p>Body text</p>'))
      const result = await getPageContent.handler!({ pageId: 'p-1' } as any, makeContext())
      expect((result as any).format).toBe('markdown')
      expect((result as any).content).toContain('# Title')
      expect((result as any).content).toContain('Body text')
    })

    it('returns HTML when format is html', async () => {
      setResponseSequence(textResponse('<h1>Title</h1>'))
      const result = await getPageContent.handler!({
        pageId: 'p-1',
        format: 'html',
      } as any, makeContext())
      expect((result as any).format).toBe('html')
      expect((result as any).content).toContain('<h1>')
    })

    it('forces HTML when includeIDs is set', async () => {
      setResponseSequence(textResponse('<p data-id="p1">text</p>'))
      const result = await getPageContent.handler!({
        pageId: 'p-1',
        includeIDs: true,
      } as any, makeContext())
      expect((result as any).format).toBe('html')
      expect((result as any).note).toContain('includeIDs')
      expect(fetchCalls[0].url).toContain('includeIDs=true')
    })
  })

  describe('create-page', () => {
    it('creates a page with markdown content', async () => {
      setResponseSequence(
        jsonResponse({
          id: 'p-2',
          title: 'New Page',
          parentSection: { id: 'sec-1', displayName: 'Notes' },
        }),
      )
      const result = await createPage.handler!({
        parentSectionId: 'sec-1',
        title: 'New Page',
        content: '# Hello World',
      } as any, makeContext())
      expect((result as any).success).toBe(true)
      expect((result as any).page.title).toBe('New Page')
      expect(fetchCalls[0].method).toBe('POST')
      expect(fetchCalls[0].url).toContain('/me/onenote/sections/sec-1/pages')
    })

    it('rejects a missing title', async () => {
      expect(
        createPage.handler!({ parentSectionId: 'sec-1', content: 'x' } as any, makeContext()),
      ).rejects.toThrow(/Specify title/)
    })

    it('rejects missing content', async () => {
      expect(
        createPage.handler!({ parentSectionId: 'sec-1', title: 'T' } as any, makeContext()),
      ).rejects.toThrow(/Specify content/)
    })

    it('rejects a missing section id', async () => {
      expect(
        createPage.handler!({ title: 'T', content: 'C' } as any, makeContext()),
      ).rejects.toThrow(/Specify parentSectionId or sectionId/)
    })
  })

  describe('delete-page', () => {
    it('sends a DELETE request', async () => {
      setResponseSequence(noContentResponse())
      const result = await deletePage.handler!({ pageId: 'p-1' } as any, makeContext())
      expect((result as any).success).toBe(true)
      expect((result as any).deleted).toBe(true)
      expect(fetchCalls[0].method).toBe('DELETE')
      expect(fetchCalls[0].url).toContain('/me/onenote/pages/p-1')
    })

    it('rejects a missing pageId', async () => {
      expect(deletePage.handler!({} as any, makeContext())).rejects.toThrow(/Specify pageId/)
    })
  })

  // ===========================================================================
  // EDITING
  // ===========================================================================

  describe('append-to-page', () => {
    it('sends a PATCH with append action', async () => {
      setResponseSequence(noContentResponse())
      const result = await appendToPage.handler!({
        pageId: 'p-1',
        content: 'More text',
      } as any, makeContext())
      expect((result as any).success).toBe(true)
      expect(fetchCalls[0].method).toBe('PATCH')
      expect(fetchCalls[0].url).toContain('/me/onenote/pages/p-1/content')
      const patchBody = JSON.parse(fetchCalls[0].body!)
      expect(patchBody[0].action).toBe('append')
      expect(patchBody[0].target).toBe('body')
      expect(patchBody[0].position).toBe('after')
    })

    it('rejects missing content', async () => {
      expect(
        appendToPage.handler!({ pageId: 'p-1' } as any, makeContext()),
      ).rejects.toThrow(/Specify content/)
    })
  })

  describe('replace-page-content', () => {
    it('sends a PATCH with replace action', async () => {
      setResponseSequence(noContentResponse())
      const result = await replacePageContent.handler!({
        pageId: 'p-1',
        content: 'Replacement',
      } as any, makeContext())
      expect((result as any).success).toBe(true)
      expect((result as any).replaced).toBe(true)
      const patchBody = JSON.parse(fetchCalls[0].body!)
      expect(patchBody[0].action).toBe('replace')
      expect(patchBody[0].target).toBe('body')
    })

    it('escapes title content as plain text', async () => {
      setResponseSequence(noContentResponse())
      await replacePageContent.handler!({
        pageId: 'p-1',
        content: '<script>alert(1)</script>',
        target: 'title',
      } as any, makeContext())
      const patchBody = JSON.parse(fetchCalls[0].body!)
      expect(patchBody[0].content).toContain('&lt;script&gt;')
      expect(patchBody[0].content).not.toContain('<script>')
    })

    it('rejects empty content', async () => {
      expect(
        replacePageContent.handler!({ pageId: 'p-1', content: '' } as any, makeContext()),
      ).rejects.toThrow(/Specify content/)
    })
  })

  // ===========================================================================
  // SEARCH
  // ===========================================================================

  describe('search-pages', () => {
    it('uses $search when available', async () => {
      setResponseSequence(
        jsonResponse({
          value: [{ id: 'p-1', title: 'Meeting Notes', parentSection: { id: 'sec-1' } }],
        }),
      )
      const result = await searchPages.handler!({ query: 'meeting' } as any, makeContext())
      expect((result as any).searchMethod).toBe('search')
      expect((result as any).count).toBe(1)
      expect(fetchCalls[0].url).toContain('$search=meeting')
    })

    it('falls back to $filter when $search is unsupported', async () => {
      // First fetch: $search returns 400 BadRequest
      // Second fetch: $filter returns results
      let callCount = 0
      nextResponse = () => {
        callCount++
        if (callCount === 1) {
          return jsonResponse(
            { error: { code: 'BadRequest', message: '$search is not supported' } },
            400,
          )
        }
        return jsonResponse({
          value: [{ id: 'p-2', title: 'meeting notes', parentSection: { id: 'sec-1' } }],
        })
      }
      const result = await searchPages.handler!({ query: 'meeting' } as any, makeContext())
      expect((result as any).searchMethod).toBe('filter')
      expect((result as any).count).toBe(1)
    })

    it('returns an explained empty result when both search and filter fail', async () => {
      let callCount = 0
      nextResponse = () => {
        callCount++
        return jsonResponse(
          { error: { code: 'BadRequest', message: 'not supported' } },
          400,
        )
      }
      const result = await searchPages.handler!({ query: 'nothing' } as any, makeContext())
      expect((result as any).searchMethod).toBe('none')
      expect((result as any).count).toBe(0)
      expect((result as any).note).toContain('rejected')
    })

    it('rejects an empty query', async () => {
      expect(searchPages.handler!({ query: '' } as any, makeContext())).rejects.toThrow(
        /Specify query/,
      )
    })
  })
})
