/**
 * Tests for the Microsoft OneDrive MCA.
 *
 * Ported from agentapps-private/apps/microsoft-onedrive/test/microsoft-onedrive.test.ts
 * Adapted from @agentapps/protocol in-process transport to direct ToolConfig.handler calls.
 *
 * Mocks the Microsoft Graph API via globalThis.fetch so tests run without real credentials.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtempSync, readFileSync as readBack, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── Import all tools ───────────────────────────────────────────────────────

const {
  listItems, getItem, searchItems,
  downloadFile, getFileContent, convertFile, uploadFile,
  createFolder, copyItem, moveItem, renameItem, deleteItem,
  createShareLink, invitePeople, listPermissions, removePermission,
  listSharedWithMe, listRecent,
  getDriveInfo, listVersions,
} = await import('../../src/tools')

const { createGraphClient } = await import('../../src/lib')
import type { GraphSecrets } from '../../src/lib'

// ─── Mock fixtures ──────────────────────────────────────────────────────────

const systemSecrets = {
  CLIENT_ID: 'test-client-id',
  CLIENT_SECRET: 'test-client-secret',
  REDIRECT_URI: 'http://localhost/callback',
}

let userSecrets: Record<string, string> = {
  ACCESS_TOKEN: 'test-access-token',
  REFRESH_TOKEN: 'test-refresh-token',
  EMAIL: 'user@outlook.com',
  EXPIRY_DATE: new Date(Date.now() + 3600_000).toISOString(),
}

let updatedSecrets: Array<Record<string, string>> = []
let fetchCalls: Array<{ url: string; init?: RequestInit }> = []

function buildCtx(): any {
  return {
    execution: { userId: 'u_test', appId: 'app_1' },
    signal: new AbortController().signal,
    getSystemSecrets: async () => systemSecrets,
    getUserSecrets: async () => userSecrets,
    updateUserSecrets: async (s: Record<string, string>) => {
      updatedSecrets.push(s)
      Object.assign(userSecrets, s)
    },
    getScope: () => 'test',
    getData: async () => ({ value: null, exists: false }),
    setData: async () => ({ success: true }),
    deleteData: async () => ({ success: true, deleted: true }),
    listData: async () => ({ keys: [] }),
    volume: {} as any,
    share: {} as any,
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function binaryResponse(data: Buffer, contentType = 'application/octet-stream'): Response {
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: { 'content-type': contentType },
  })
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status, headers: {} })
}

let nextFetch: ((url: string, init?: RequestInit) => Response | Promise<Response>) | null = null

const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url)
    fetchCalls.push({ url: u, init })
    if (nextFetch) return await nextFetch(u, init)
    return jsonResponse({})
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

beforeEach(() => {
  userSecrets = {
    ACCESS_TOKEN: 'test-access-token',
    REFRESH_TOKEN: 'test-refresh-token',
    EMAIL: 'user@outlook.com',
    EXPIRY_DATE: new Date(Date.now() + 3600_000).toISOString(),
  }
  updatedSecrets = []
  fetchCalls = []
  nextFetch = null
})

afterEach(() => {
  vi.unstubAllGlobals?.()
  vi.useRealTimers?.()
})

// Helper: find a fetch call matching a predicate
function findCall(pred: (url: string, init?: RequestInit) => boolean): { url: string; init?: RequestInit } | undefined {
  return fetchCalls.find((c) => pred(c.url, c.init))
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Microsoft OneDrive MCA', () => {

  // ── Manifest & registration ──────────────────────────────────────────────

  it('registers all 20 tools', () => {
    const tools = [
      listItems, getItem, searchItems,
      downloadFile, getFileContent, convertFile, uploadFile,
      createFolder, copyItem, moveItem, renameItem, deleteItem,
      createShareLink, invitePeople, listPermissions, removePermission,
      listSharedWithMe, listRecent,
      getDriveInfo, listVersions,
    ]
    for (const tool of tools) {
      expect(tool).toBeDefined()
      expect(typeof tool.handler).toBe('function')
    }
    expect(tools.length).toBe(20)
  })

  it('manifest has correct scopes', () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'manifest.json'), 'utf-8'),
    )
    const scopes = manifest.layers.auth.scopes
    expect(scopes).toContain('Files.ReadWrite.All')
    expect(scopes).toContain('Sites.Read.All')
  })

  // ── Browse ────────────────────────────────────────────────────────────────

  it('list-items returns formatted children of the drive root', async () => {
    nextFetch = () => jsonResponse({
      value: [
        { id: 'item-1', name: 'Reports', folder: { childCount: 3 }, size: 0, createdDateTime: '2026-08-01T10:00:00Z', lastModifiedDateTime: '2026-08-02T11:00:00Z', webUrl: 'https://onedrive.live.com/reports', parentReference: { id: 'root', path: '/drive/root:' } },
        { id: 'item-2', name: 'budget.xlsx', file: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, size: 20480, createdDateTime: '2026-08-03T09:00:00Z', lastModifiedDateTime: '2026-08-04T09:00:00Z', webUrl: 'https://onedrive.live.com/budget', parentReference: { id: 'root', path: '/drive/root:' } },
      ],
    })
    const result = await listItems.handler!({} as any, buildCtx())
    expect(result.account).toBe('user@outlook.com')
    expect(result.count).toBe(2)
    const items = result.items as any[]
    expect(items[0].name).toBe('Reports')
    expect(items[0].type).toBe('folder')
    expect(items[0].childCount).toBe(3)
    expect(items[1].name).toBe('budget.xlsx')
    expect(items[1].type).toBe('file')
    expect(items[1].size).toBe(20480)
  })

  it('list-items addresses a folder by path when given one', async () => {
    nextFetch = () => jsonResponse({ value: [] })
    await listItems.handler!({ path: 'Documents/Reports' } as any, buildCtx())
    const call = findCall((u) => u.includes('/children'))
    expect(call).toBeDefined()
    expect(call!.url).toContain('/me/drive/root:/Documents/Reports:/children')
  })

  it('get-item returns a single formatted item by id', async () => {
    nextFetch = () => jsonResponse({
      id: 'item-9', name: 'notes.txt', file: { mimeType: 'text/plain' }, size: 128,
      createdDateTime: '2026-08-05T10:00:00Z', lastModifiedDateTime: '2026-08-05T12:00:00Z',
      webUrl: 'https://onedrive.live.com/notes', parentReference: { id: 'root', path: '/drive/root:' },
    })
    const result = await getItem.handler!({ itemId: 'item-9' } as any, buildCtx())
    const item = result.item as any
    expect(item.id).toBe('item-9')
    expect(item.name).toBe('notes.txt')
    expect(item.mimeType).toBe('text/plain')
  })

  it('search-items passes the query to the Graph search endpoint', async () => {
    nextFetch = () => jsonResponse({ value: [{ id: 'hit-1', name: 'invoice.pdf', file: {} }] })
    const result = await searchItems.handler!({ query: 'invoice' } as any, buildCtx())
    expect(result.query).toBe('invoice')
    expect(result.count).toBe(1)
    const call = findCall((u) => u.includes('search'))
    expect(call!.url).toContain("/me/drive/root/search(q='invoice')")
  })

  // ── Content ───────────────────────────────────────────────────────────────

  it('download-file writes the file to the given output directory', async () => {
    const outputPath = mkdtempSync(join(tmpdir(), 'onedrive-test-'))
    const fileBytes = Buffer.from('hello onedrive', 'utf-8')
    nextFetch = (url) => {
      if (url.includes('/content')) return binaryResponse(fileBytes)
      return jsonResponse({ id: 'item-1', name: 'hello.txt', size: fileBytes.length, file: {} })
    }
    const result = await downloadFile.handler!({ itemId: 'item-1', outputPath } as any, buildCtx())
    expect(result.name).toBe('hello.txt')
    expect(readBack(result.savedTo as string).length).toBe(fileBytes.length)
  })

  it('download-file selects the folder facet so folders can be detected', async () => {
    nextFetch = (url) => {
      if (url.includes('/content')) return binaryResponse(Buffer.alloc(0))
      return jsonResponse({ id: 'item-1', name: 'hello.txt', size: 0, file: {} })
    }
    const outputPath = mkdtempSync(join(tmpdir(), 'onedrive-test-'))
    await downloadFile.handler!({ itemId: 'item-1', outputPath } as any, buildCtx())
    const metaCall = findCall((u) => u.includes('$select') && !u.includes('/content'))
    expect(metaCall).toBeDefined()
    expect(metaCall!.url).toContain('folder')
  })

  it('download-file refuses files above the 50 MB ceiling', async () => {
    nextFetch = () => jsonResponse({ id: 'big', name: 'big.zip', size: 60 * 1024 * 1024, file: {} })
    await expect(
      downloadFile.handler!({ itemId: 'big' } as any, buildCtx()),
    ).rejects.toThrow('50 MB')
  })

  it('get-file-content returns text inline', async () => {
    nextFetch = (url) => {
      if (url.includes('/content')) return binaryResponse(Buffer.from('line one\nline two'), 'text/plain')
      return jsonResponse({ id: 'item-2', name: 'notes.txt', size: 17, file: { mimeType: 'text/plain' } })
    }
    const result = await getFileContent.handler!({ itemId: 'item-2' } as any, buildCtx())
    expect(result.content).toContain('line one')
    expect(result.name).toBe('notes.txt')
  })

  it('get-file-content refuses binary content', async () => {
    nextFetch = () => jsonResponse({
      id: 'item-3', name: 'report.docx', size: 2048,
      file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    })
    await expect(
      getFileContent.handler!({ itemId: 'item-3' } as any, buildCtx()),
    ).rejects.toThrow('is not text')
  })

  it('convert-file requests the PDF rendition', async () => {
    const outputPath = mkdtempSync(join(tmpdir(), 'onedrive-pdf-'))
    nextFetch = (url) => {
      if (url.includes('format=pdf')) return binaryResponse(Buffer.from('%PDF-1.7'), 'application/pdf')
      return jsonResponse({ id: 'doc-1', name: 'report.docx', size: 4096, file: {} })
    }
    const result = await convertFile.handler!({ itemId: 'doc-1', outputPath } as any, buildCtx())
    expect(result.savedTo as string).toContain('report.pdf')
    expect(findCall((u) => u.includes('format=pdf'))).toBeDefined()
  })

  it('convert-file refuses a folder', async () => {
    nextFetch = () => jsonResponse({ id: 'folder-1', name: 'Reports', folder: {} })
    await expect(
      convertFile.handler!({ itemId: 'folder-1' } as any, buildCtx()),
    ).rejects.toThrow('is a folder')
    expect(findCall((u) => u.includes('format=pdf'))).toBeUndefined()
  })

  it('convert-file refuses files above the 50 MB ceiling', async () => {
    nextFetch = () => jsonResponse({ id: 'big', name: 'big.docx', size: 60 * 1024 * 1024, file: {} })
    await expect(
      convertFile.handler!({ itemId: 'big' } as any, buildCtx()),
    ).rejects.toThrow('50 MB')
    expect(findCall((u) => u.includes('format=pdf'))).toBeUndefined()
  })

  it('upload-file uses a simple PUT for small files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onedrive-up-'))
    const localPath = join(dir, 'small.txt')
    writeFileSync(localPath, 'small payload')
    nextFetch = () => jsonResponse({ id: 'new-1', name: 'small.txt', size: 13, file: {} })
    await uploadFile.handler!({ localPath, destinationPath: 'Documents' } as any, buildCtx())
    const uploadCall = findCall((u) => u.includes(':/content'))
    expect(uploadCall).toBeDefined()
    expect(uploadCall!.init!.method).toBe('PUT')
    expect(uploadCall!.url).toContain('/me/drive/root:/Documents/small.txt:/content')
    expect(findCall((u) => u.includes('createUploadSession'))).toBeUndefined()
  })

  it('upload-file creates an upload session for files at or above 4 MB, chunked to tile the file exactly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onedrive-big-'))
    const localPath = join(dir, 'big.bin')
    const size = 5 * 1024 * 1024
    writeFileSync(localPath, Buffer.alloc(size, 1))
    const CHUNK_SIZE = 5 * 320 * 1024
    const chunkPuts: Array<{ start: number; end: number; total: number }> = []

    nextFetch = (url, init) => {
      if (url.includes('createUploadSession')) {
        return jsonResponse({ uploadUrl: 'https://upload.example/session-1', expirationDateTime: '' })
      }
      if (url.startsWith('https://upload.example/')) {
        const headers = init?.headers as Record<string, string>
        const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers['Content-Range'])
        if (!match) throw new Error(`Chunk PUT missing Content-Range: ${JSON.stringify(headers)}`)
        const start = Number(match[1]); const end = Number(match[2]); const total = Number(match[3])
        chunkPuts.push({ start, end, total })
        const isFinal = end === total - 1
        return isFinal
          ? jsonResponse({ id: 'new-2', name: 'big.bin', size: total, file: {} }, 201)
          : jsonResponse({}, 202)
      }
      return jsonResponse({})
    }

    const result = await uploadFile.handler!({ localPath, destinationPath: 'Documents' } as any, buildCtx())
    expect((result.item as any).name).toBe('big.bin')
    expect(findCall((u) => u.includes('createUploadSession'))).toBeDefined()
    expect(chunkPuts.length).toBe(Math.ceil(size / CHUNK_SIZE))
    let expectedStart = 0
    for (const put of chunkPuts) {
      expect(put.start).toBe(expectedStart)
      expect(put.total).toBe(size)
      expectedStart = put.end + 1
    }
    expect(expectedStart).toBe(size)
    expect(chunkPuts[chunkPuts.length - 1].end).toBe(size - 1)
  })

  it('upload-file reports a clear error when the local file is missing', async () => {
    await expect(
      uploadFile.handler!({ localPath: '/nonexistent/nope.txt' } as any, buildCtx()),
    ).rejects.toThrow('not found')
  })

  // ── Organize ──────────────────────────────────────────────────────────────

  it('create-folder posts a folder facet to the parent', async () => {
    nextFetch = () => jsonResponse({ id: 'f-1', name: 'Reports', folder: { childCount: 0 } })
    await createFolder.handler!({ name: 'Reports' } as any, buildCtx())
    const call = findCall((u) => u.includes('/children'))
    expect(call!.init!.method).toBe('POST')
    const body = JSON.parse(call!.init!.body as string)
    expect(body.name).toBe('Reports')
    expect(body.folder).toEqual({})
  })

  it('create-folder creates inside the folder named by parentPath', async () => {
    nextFetch = () => jsonResponse({ id: 'f-2', name: 'Q3', folder: { childCount: 0 } })
    await createFolder.handler!({ name: 'Q3', parentPath: 'Documents/Reports' } as any, buildCtx())
    const call = findCall((u) => u.includes('/children'))
    expect(call!.url).toContain('/me/drive/root:/Documents/Reports:/children')
    expect(JSON.parse(call!.init!.body as string).name).toBe('Q3')
  })

  it('create-folder still accepts the legacy itemId alias for the parent', async () => {
    nextFetch = () => jsonResponse({ id: 'f-3', name: 'Q4', folder: { childCount: 0 } })
    await createFolder.handler!({ name: 'Q4', itemId: 'parent-1' } as any, buildCtx())
    const call = findCall((u) => u.includes('/children'))
    expect(call!.url).toContain('/me/drive/items/parent-1/children')
  })

  it('move-item patches the parent reference', async () => {
    nextFetch = () => jsonResponse({ id: 'item-1', name: 'a.txt', file: {} })
    await moveItem.handler!({ itemId: 'item-1', destinationFolderId: 'f-2' } as any, buildCtx())
    const call = findCall((_, init) => init?.method === 'PATCH')
    expect(call).toBeDefined()
    const body = JSON.parse(call!.init!.body as string)
    expect(body.parentReference.id).toBe('f-2')
  })

  it('move-item builds an encoded parentReference path from destinationPath', async () => {
    nextFetch = () => jsonResponse({ id: 'item-1', name: 'a.txt', file: {} })
    await moveItem.handler!({ itemId: 'item-1', destinationPath: 'Archive/Q3 #2' } as any, buildCtx())
    const call = findCall((_, init) => init?.method === 'PATCH')
    expect(call).toBeDefined()
    const body = JSON.parse(call!.init!.body as string)
    expect(body.parentReference).toEqual({ path: '/drive/root:/Archive/Q3%20%232' })
  })

  it('rename-item patches the name', async () => {
    nextFetch = () => jsonResponse({ id: 'item-1', name: 'renamed.txt', file: {} })
    const result = await renameItem.handler!({ itemId: 'item-1', newName: 'renamed.txt' } as any, buildCtx())
    expect((result.item as any).name).toBe('renamed.txt')
    const call = findCall((_, init) => init?.method === 'PATCH')
    expect(JSON.parse(call!.init!.body as string).name).toBe('renamed.txt')
  })

  it('delete-item issues a DELETE and reports success', async () => {
    nextFetch = () => emptyResponse(204)
    const result = await deleteItem.handler!({ itemId: 'item-1' } as any, buildCtx())
    expect(result.success).toBe(true)
    const call = findCall((_, init) => init?.method === 'DELETE')
    expect(call!.url).toContain('/me/drive/items/item-1')
  })

  it('delete-item percent-encodes the path so a # cannot retarget the request', async () => {
    nextFetch = () => emptyResponse(204)
    await deleteItem.handler!({ path: 'Reports/2026#final.xlsx' } as any, buildCtx())
    const call = findCall((_, init) => init?.method === 'DELETE')
    expect(call).toBeDefined()
    expect(call!.url).toBe('https://graph.microsoft.com/v1.0/me/drive/root:/Reports/2026%23final.xlsx:')
    expect(call!.url).not.toContain('#')
  })

  it('delete-item refuses a call with neither itemId nor path', async () => {
    nextFetch = () => jsonResponse({})
    await expect(
      deleteItem.handler!({ itmeId: 'item-1' } as any, buildCtx()),
    ).rejects.toThrow('Specify itemId or path.')
    expect(findCall((_, init) => init?.method === 'DELETE')).toBeUndefined()
  })

  // ── Sharing ───────────────────────────────────────────────────────────────

  it('create-share-link requests the given link type and scope', async () => {
    nextFetch = () => jsonResponse({
      id: 'perm-1', link: { type: 'view', scope: 'anonymous', webUrl: 'https://1drv.ms/abc' },
    })
    const result = await createShareLink.handler!({ itemId: 'item-1', type: 'edit', scope: 'organization' } as any, buildCtx())
    expect(result.url).toBe('https://1drv.ms/abc')
    const call = findCall((u) => u.includes('createLink'))
    expect(call!.url).toContain('/me/drive/items/item-1')
    expect(call!.init!.method).toBe('POST')
    const body = JSON.parse(call!.init!.body as string)
    expect(body.type).toBe('edit')
    expect(body.scope).toBe('organization')
  })

  it('invite-people sends recipients and a role', async () => {
    nextFetch = () => jsonResponse({ value: [{ id: 'perm-2', roles: ['write'] }] })
    await invitePeople.handler!({
      itemId: 'item-1', emails: 'alice@example.com, bob@example.com', role: 'write', message: 'Please review',
    } as any, buildCtx())
    const call = findCall((u) => u.includes('/invite'))
    expect(call!.url).toContain('/me/drive/items/item-1')
    expect(call!.init!.method).toBe('POST')
    const body = JSON.parse(call!.init!.body as string)
    expect(body.recipients).toEqual([{ email: 'alice@example.com' }, { email: 'bob@example.com' }])
    expect(body.roles).toEqual(['write'])
    expect(body.message).toBe('Please review')
  })

  it('list-permissions returns formatted grants', async () => {
    nextFetch = () => jsonResponse({
      value: [
        { id: 'perm-1', roles: ['read'], grantedToV2: { user: { displayName: 'Alice', email: 'alice@example.com' } } },
        { id: 'perm-2', roles: ['write'], link: { type: 'edit', scope: 'anonymous' } },
      ],
    })
    const result = await listPermissions.handler!({ itemId: 'item-1' } as any, buildCtx())
    expect(result.count).toBe(2)
    const perms = result.permissions as any[]
    expect(perms[0].grantedTo).toBe('Alice <alice@example.com>')
    expect(perms[1].linkType).toBe('edit')
  })

  it('remove-permission deletes the grant', async () => {
    nextFetch = () => emptyResponse(204)
    await removePermission.handler!({ itemId: 'item-1', permissionId: 'perm-1' } as any, buildCtx())
    const call = findCall((_, init) => init?.method === 'DELETE')
    expect(call!.url).toContain('/me/drive/items/item-1')
    expect(call!.url).toContain('/permissions/perm-1')
  })

  // ── Discovery ─────────────────────────────────────────────────────────────

  it('list-shared-with-me formats the remoteItem facets, not the shortcut entry', async () => {
    nextFetch = () => jsonResponse({
      value: [
        {
          id: 'shortcut-1', name: 'Team Plan.docx',
          remoteItem: {
            id: 'remote-1', name: 'Team Plan.docx',
            file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
            size: 24576, lastModifiedDateTime: '2026-08-11T09:00:00Z',
            webUrl: 'https://contoso-my.sharepoint.com/plan',
            parentReference: { driveId: 'b!drive-of-alice', id: 'alice-root' },
          },
        },
        {
          id: 'shortcut-2', name: 'Design Assets',
          remoteItem: {
            id: 'remote-2', name: 'Design Assets', folder: { childCount: 12 }, size: 0,
            lastModifiedDateTime: '2026-08-12T09:00:00Z',
            webUrl: 'https://contoso-my.sharepoint.com/assets',
            parentReference: { driveId: 'b!drive-of-bob', id: 'bob-root' },
          },
        },
      ],
    })
    const result = await listSharedWithMe.handler!({} as any, buildCtx())
    expect(result.count).toBe(2)
    const items = result.items as any[]
    expect(items[0].name).toBe('Team Plan.docx')
    expect(items[0].type).toBe('file')
    expect(items[0].size).toBe(24576)
    expect(items[0].remoteItemId).toBe('remote-1')
    expect(items[0].remoteDriveId).toBe('b!drive-of-alice')
    expect(items[1].name).toBe('Design Assets')
    expect(items[1].type).toBe('folder')
    expect(items[1].childCount).toBe(12)
    expect(items[1].remoteItemId).toBe('remote-2')
    expect(items[1].remoteDriveId).toBe('b!drive-of-bob')
  })

  it('list-recent returns recently accessed items', async () => {
    nextFetch = () => jsonResponse({ value: [{ id: 'r-1', name: 'recent.txt', file: {} }] })
    const result = await listRecent.handler!({} as any, buildCtx())
    expect(result.count).toBe(1)
    expect(findCall((u) => u.includes('/me/drive/recent'))).toBeDefined()
  })

  // ── Account ───────────────────────────────────────────────────────────────

  it('get-drive-info reports quota', async () => {
    nextFetch = () => jsonResponse({
      id: 'drive-1', driveType: 'personal',
      quota: { total: 1099511627776, used: 549755813888, remaining: 549755813888, state: 'normal' },
    })
    const result = await getDriveInfo.handler!({} as any, buildCtx())
    expect(result.driveType).toBe('personal')
    expect(result.quota.usedGB).toBe('512.00')
    expect(result.quota.totalGB).toBe('1024.00')
  })

  it('list-versions returns the version history of an item', async () => {
    nextFetch = () => jsonResponse({
      value: [
        { id: '2.0', lastModifiedDateTime: '2026-08-10T10:00:00Z', size: 2048 },
        { id: '1.0', lastModifiedDateTime: '2026-08-09T10:00:00Z', size: 1024 },
      ],
    })
    const result = await listVersions.handler!({ itemId: 'item-1' } as any, buildCtx())
    expect(result.count).toBe(2)
    const versions = result.versions as any[]
    expect(versions[0].id).toBe('2.0')
    expect(versions[0].size).toBe(2048)
  })

  // ── Copy-item ─────────────────────────────────────────────────────────────

  it('copy-item polls the monitor URL until the copy completes', async () => {
    let monitorCalls = 0
    nextFetch = (url) => {
      if (url.endsWith('/copy')) {
        return new Response(null, { status: 202, headers: { location: 'https://monitor.example/op-1' } })
      }
      if (url.startsWith('https://monitor.example/')) {
        monitorCalls++
        return monitorCalls === 1
          ? jsonResponse({ status: 'inProgress', percentageComplete: 40 })
          : jsonResponse({ status: 'completed', resourceId: 'copy-1' })
      }
      return jsonResponse({ id: 'copy-1', name: 'a-copy.txt', file: {} })
    }
    const result = await copyItem.handler!({
      itemId: 'item-1', destinationFolderId: 'f-2', newName: 'a-copy.txt', pollIntervalMs: 0,
    } as any, buildCtx())
    expect(result.status).toBe('completed')
    expect((result.item as any).name).toBe('a-copy.txt')
    expect(monitorCalls).toBe(2)
    const postCall = findCall((_, init) => init?.method === 'POST')
    expect(postCall!.url).toContain('/me/drive/items/item-1/copy')
    const postBody = JSON.parse(postCall!.init!.body as string)
    expect(postBody.parentReference).toEqual({ id: 'f-2' })
    expect(postBody.name).toBe('a-copy.txt')
    const monitorCall = findCall((u) => u.startsWith('https://monitor.example/'))
    expect((monitorCall!.init!.headers as any)?.Authorization).toBeUndefined()
  })

  it('copy-item includes the bearer token when the monitor URL stays on graph.microsoft.com', async () => {
    let monitorCalls = 0
    nextFetch = (url) => {
      if (url.endsWith('/copy')) {
        return new Response(null, { status: 202, headers: { location: 'https://graph.microsoft.com/v1.0/monitor/op-3' } })
      }
      if (url.includes('/monitor/')) {
        monitorCalls++
        return jsonResponse({ status: 'completed', resourceId: 'copy-2' })
      }
      return jsonResponse({ id: 'copy-2', name: 'a-copy.txt', file: {} })
    }
    await copyItem.handler!({ itemId: 'item-1', destinationFolderId: 'f-2', pollIntervalMs: 0 } as any, buildCtx())
    expect(monitorCalls).toBe(1)
    const monitorCall = findCall((u) => u.includes('/monitor/'))
    expect((monitorCall!.init!.headers as any)?.Authorization).toBe('Bearer test-access-token')
  })

  it('copy-item reports a failed copy operation', async () => {
    nextFetch = (url) => {
      if (url.endsWith('/copy')) {
        return new Response(null, { status: 202, headers: { location: 'https://monitor.example/op-2' } })
      }
      return jsonResponse({ status: 'failed', error: { message: 'Name already exists' } })
    }
    await expect(
      copyItem.handler!({ itemId: 'item-1', destinationFolderId: 'f-2', pollIntervalMs: 0 } as any, buildCtx()),
    ).rejects.toThrow('Name already exists')
  })

  it('copy-item surfaces the Graph error message when the copy fails to start', async () => {
    nextFetch = (url) => {
      if (url.endsWith('/copy')) {
        return jsonResponse({
          error: {
            code: 'nameAlreadyExists',
            message: 'An item with this name already exists in this location.',
            innerError: { 'request-id': 'req-copy-1' },
          },
        }, 409)
      }
      return jsonResponse({})
    }
    await expect(
      copyItem.handler!({ itemId: 'item-1', destinationFolderId: 'f-2', pollIntervalMs: 0 } as any, buildCtx()),
    ).rejects.toThrow('An item with this name already exists')
  })

  // ── Auth & retry ──────────────────────────────────────────────────────────

  it('persists refreshed tokens through updateUser when the access token is expired', async () => {
    userSecrets.EXPIRY_DATE = new Date(Date.now() - 60_000).toISOString()
    nextFetch = (url) => {
      if (url.includes('/oauth2/v2.0/token')) {
        return jsonResponse({ access_token: 'refreshed-access-token', refresh_token: 'refreshed-refresh-token', expires_in: 60 })
      }
      return jsonResponse({ id: 'drive-1', driveType: 'personal' })
    }
    // Trigger a tool call that builds a graph client
    await getDriveInfo.handler!({} as any, buildCtx())
    expect(updatedSecrets.length).toBeGreaterThan(0)
    const persisted = updatedSecrets[0]
    expect(persisted.ACCESS_TOKEN).toBe('refreshed-access-token')
    expect(persisted.REFRESH_TOKEN).toBe('refreshed-refresh-token')
    const expiryMs = new Date(persisted.EXPIRY_DATE).getTime()
    expect(expiryMs).toBeGreaterThan(Date.now())
    expect(expiryMs).toBeLessThan(Date.now() + 120_000)
  })

  it('never includes the access token in error messages', async () => {
    nextFetch = () => jsonResponse({
      error: { code: 'InvalidAuthenticationToken', message: 'Access token is expired.', innerError: { 'request-id': 'req-abc-123' } },
    }, 401)
    await expect(
      getItem.handler!({ itemId: 'item-9' } as any, buildCtx()),
    ).rejects.toThrow()
    // The error should not contain the access token
    try {
      await getItem.handler!({ itemId: 'item-9' } as any, buildCtx())
    } catch (e: any) {
      expect(e.message).not.toContain('test-access-token')
    }
  })

  it('retries a throttled GET and returns the eventual success', async () => {
    let calls = 0
    nextFetch = () => {
      calls++
      if (calls === 1) return jsonResponse({ error: { code: 'activityLimitReached' } }, 429, { 'retry-after': '0' })
      return jsonResponse({ id: 'drive-1', driveType: 'personal' })
    }
    const result = await getDriveInfo.handler!({} as any, buildCtx())
    expect(result.driveType).toBe('personal')
    expect(calls).toBe(2)
  })

  it('refreshes and replays once when Graph answers 401 mid-flight', async () => {
    let graphCalls = 0
    nextFetch = (url) => {
      if (url.includes('/oauth2/v2.0/token')) {
        return jsonResponse({ access_token: 'reactive-access-token', refresh_token: 'reactive-refresh-token', expires_in: 3600 })
      }
      graphCalls++
      if (graphCalls === 1) {
        return jsonResponse({ error: { code: 'InvalidAuthenticationToken', message: 'Access token is expired.' } }, 401)
      }
      return jsonResponse({ id: 'item-9', name: 'notes.txt', file: {} })
    }
    const result = await getItem.handler!({ itemId: 'item-9' } as any, buildCtx())
    expect((result.item as any).name).toBe('notes.txt')
    expect(graphCalls).toBe(2)
    expect(updatedSecrets.some((s) => s.ACCESS_TOKEN === 'reactive-access-token')).toBe(true)
  })

  it('tells the user to reconnect when a 401 survives the refresh', async () => {
    let graphCalls = 0
    nextFetch = (url) => {
      if (url.includes('/oauth2/v2.0/token')) {
        return jsonResponse({ access_token: 'still-rejected-token', expires_in: 3600 })
      }
      graphCalls++
      return jsonResponse({ error: { code: 'InvalidAuthenticationToken', message: 'Access token is expired.' } }, 401)
    }
    await expect(
      getItem.handler!({ itemId: 'item-9' } as any, buildCtx()),
    ).rejects.toThrow('reconnect your Microsoft account')
  })

  it('reports the reconnect message when the refresh itself fails on a 401', async () => {
    nextFetch = (url) => {
      if (url.includes('/oauth2/v2.0/token')) return jsonResponse({ error: 'invalid_grant' }, 400)
      return jsonResponse({ error: { code: 'InvalidAuthenticationToken', message: 'Access token is expired.' } }, 401)
    }
    await expect(
      getItem.handler!({ itemId: 'item-9' } as any, buildCtx()),
    ).rejects.toThrow('reconnect your Microsoft account')
  })

  it('gives up after 3 attempts on sustained throttling', async () => {
    let calls = 0
    nextFetch = () => {
      calls++
      return jsonResponse({ error: { code: 'activityLimitReached', message: 'Throttled.' } }, 429, { 'retry-after': '0' })
    }
    await expect(
      getDriveInfo.handler!({} as any, buildCtx()),
    ).rejects.toThrow()
    expect(calls).toBe(3)
  })

  it('does not retry a throttled POST', async () => {
    let calls = 0
    nextFetch = () => {
      calls++
      return jsonResponse({ error: { code: 'activityLimitReached', message: 'Throttled.' } }, 429, { 'retry-after': '0' })
    }
    await expect(
      createFolder.handler!({ name: 'Reports' } as any, buildCtx()),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })

  // ── Retry-After (direct graph-client tests) ───────────────────────────────

  describe('Retry-After', () => {
    async function buildDirectClient() {
      const secrets = { ...systemSecrets, ...userSecrets } as GraphSecrets
      return createGraphClient(
        secrets,
        async (s: Record<string, string>) => { updatedSecrets.push(s) },
        'OneDrive',
        'Files.ReadWrite.All',
      )
    }

    it('waits the advertised Retry-After instead of the exponential backoff', async () => {
      let calls = 0
      nextFetch = () => {
        calls++
        if (calls === 1) return jsonResponse({ error: { code: 'activityLimitReached' } }, 429, { 'retry-after': '1' })
        return jsonResponse({ id: 'drive-1', driveType: 'personal' })
      }
      const client = await buildDirectClient()
      const start = Date.now()
      const result = await client.graphRequest('GET', '/me/drive')
      const elapsed = Date.now() - start
      expect(result).toMatchObject({ id: 'drive-1' })
      expect(calls).toBe(2)
      // Retry-After is 1s; exponential backoff for attempt 0 would be 500ms.
      // If we waited >= 900ms, the Retry-After won (not the backoff).
      expect(elapsed).toBeGreaterThanOrEqual(900)
    })

    it('clamps a large Retry-After to the 10 s ceiling', async () => {
      let calls = 0
      nextFetch = () => {
        calls++
        if (calls === 1) return jsonResponse({ error: { code: 'activityLimitReached' } }, 429, { 'retry-after': '600' })
        return jsonResponse({ id: 'drive-1', driveType: 'personal' })
      }
      const client = await buildDirectClient()
      const start = Date.now()
      const result = await client.graphRequest('GET', '/me/drive')
      const elapsed = Date.now() - start
      expect(result).toMatchObject({ id: 'drive-1' })
      expect(calls).toBe(2)
      // Retry-After is 600s but MAX_RETRY_DELAY_MS is 10s.
      // The retry should fire at ~10s, not 600s.
      expect(elapsed).toBeLessThan(15_000)
      expect(elapsed).toBeGreaterThanOrEqual(9_000)
    }, 20000) // 20s timeout — needs ~10s for the clamped retry
  })
})
