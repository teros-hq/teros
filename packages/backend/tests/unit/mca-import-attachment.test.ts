/**
 * import_channel_attachment handler tests.
 *
 * Covers the WS action that copies a chat-uploaded file from static/uploads
 * into a workspace volume (server-side, no URL fetch). Functional + security:
 * access control, private channels, workspace-sovereign destination, path
 * traversal on destPath, symlink-escape defense, collision policy, and the
 * source-from-DB-URL guarantee (agent filename is match-only, never a path).
 *
 * Strategy: invoke handleConversationAction directly with a mock ctx. The
 * source file lives in the REAL uploadDir (imported from the handler so the
 * path matches exactly); the volume hostPath is a throwaway tmpdir.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uploadDir } from '../../src/lib/static-paths'
import { handleConversationAction } from '../../src/services/mca-connection-manager.queries-conversations'

const USER_ID = 'user_test'
const CHANNEL_ID = 'ch_test'
const WORKSPACE_ID = 'work_test'
const VOLUME_ID = 'vol_test'
const AGENT_ID = 'agent_test'

// Track artifacts to clean up.
const createdSources: string[] = []
const createdVolumes: string[] = []

function makeSourceFile(content = 'PNGDATA'): { storedName: string; url: string; size: number } {
  mkdirSync(uploadDir, { recursive: true })
  const storedName = `test-${randomUUID()}.png`
  const p = join(uploadDir, storedName)
  writeFileSync(p, content)
  createdSources.push(p)
  return { storedName, url: `http://localhost:3000/static/uploads/${storedName}`, size: content.length }
}

function makeVolume(): string {
  const hostPath = mkdtempSync(join(tmpdir(), 'vol-import-'))
  createdVolumes.push(hostPath)
  return hostPath
}

interface CtxOpts {
  hostPath: string
  messages: Array<{ messageId: string; content: unknown }>
  canAccess?: boolean
  isPrivate?: boolean
  workspaceId?: string | undefined
  volumeId?: string | undefined
  hasServices?: boolean
}

function makeCtx(opts: CtxOpts): any {
  return {
    channelManager: {
      getChannel: async (_id: string) => ({
        channelId: CHANNEL_ID,
        agentId: AGENT_ID,
        status: 'active',
        isPrivate: opts.isPrivate ?? false,
        workspaceId: 'workspaceId' in opts ? opts.workspaceId : WORKSPACE_ID,
      }),
      canAccessChannel: async () => opts.canAccess ?? true,
      getMessages: async () => ({ messages: opts.messages, hasMore: false }),
    },
    workspaceService:
      opts.hasServices === false
        ? undefined
        : { getWorkspace: async () => ({ volumeId: 'volumeId' in opts ? opts.volumeId : VOLUME_ID }) },
    volumeService:
      opts.hasServices === false
        ? undefined
        : { getVolume: async () => ({ volumeId: VOLUME_ID, hostPath: opts.hostPath }) },
  }
}

function fileMsg(messageId: string, url: string, filename: string, size: number) {
  return {
    messageId,
    content: { type: 'file', url, filename, mimeType: 'image/png', size },
  }
}

async function run(ctx: any, params: Record<string, unknown>) {
  return handleConversationAction(ctx, 'import_channel_attachment', params, USER_ID, AGENT_ID, {
    ownerId: USER_ID,
    currentChannelId: CHANNEL_ID,
  } as any)
}

afterEach(() => {
  for (const p of createdSources.splice(0)) {
    if (existsSync(p)) rmSync(p, { force: true })
  }
  for (const d of createdVolumes.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
})

describe('import_channel_attachment', () => {
  it('copies the attachment into the workspace volume (happy path)', async () => {
    const { storedName, url, size } = makeSourceFile('HELLOPNG')
    const hostPath = makeVolume()
    const ctx = makeCtx({ hostPath, messages: [fileMsg('msg_1', url, 'photo.png', size)] })

    const result: any = await run(ctx, { filename: 'photo.png' })

    expect(result.success).toBe(true)
    expect(result.workspacePath).toBe('photo.png')
    expect(result.mime).toBe('image/png')
    const dest = join(hostPath, 'photo.png')
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe('HELLOPNG')
    expect(storedName).toContain('test-')
  })

  it('honors a relative destPath subdirectory', async () => {
    const { url, size } = makeSourceFile()
    const hostPath = makeVolume()
    const ctx = makeCtx({ hostPath, messages: [fileMsg('msg_1', url, 'photo.png', size)] })

    const result: any = await run(ctx, { filename: 'photo.png', destPath: 'images/logo.png' })

    expect(result.workspacePath).toBe('images/logo.png')
    expect(existsSync(join(hostPath, 'images', 'logo.png'))).toBe(true)
  })

  it('throws on access denied', async () => {
    const { url, size } = makeSourceFile()
    const hostPath = makeVolume()
    const ctx = makeCtx({ hostPath, messages: [fileMsg('msg_1', url, 'photo.png', size)], canAccess: false })
    await expect(run(ctx, { filename: 'photo.png' })).rejects.toThrow('Access denied')
  })

  it('throws on private channels', async () => {
    const { url, size } = makeSourceFile()
    const hostPath = makeVolume()
    const ctx = makeCtx({ hostPath, messages: [fileMsg('msg_1', url, 'photo.png', size)], isPrivate: true })
    await expect(run(ctx, { filename: 'photo.png' })).rejects.toThrow('private')
  })

  it('throws when the channel has no workspace (sovereign destination)', async () => {
    const { url, size } = makeSourceFile()
    const hostPath = makeVolume()
    const ctx = makeCtx({ hostPath, messages: [fileMsg('msg_1', url, 'photo.png', size)], workspaceId: undefined })
    await expect(run(ctx, { filename: 'photo.png' })).rejects.toThrow('no workspace')
  })

  it('throws when the attachment is not present in the channel', async () => {
    const hostPath = makeVolume()
    const ctx = makeCtx({ hostPath, messages: [] })
    await expect(run(ctx, { filename: 'ghost.png' })).rejects.toThrow('No attachment named')
  })

  it('rejects path traversal in destPath', async () => {
    const { url, size } = makeSourceFile()
    const hostPath = makeVolume()
    const ctx = makeCtx({ hostPath, messages: [fileMsg('msg_1', url, 'photo.png', size)] })
    await expect(run(ctx, { filename: 'photo.png', destPath: '../escape.png' })).rejects.toThrow(
      'Path traversal',
    )
  })

  it('rejects a symlinked parent dir that escapes the volume', async () => {
    const { url, size } = makeSourceFile()
    const hostPath = makeVolume()
    // Create a symlink inside the volume pointing outside it.
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    createdVolumes.push(outside)
    symlinkSync(outside, join(hostPath, 'link'))
    const ctx = makeCtx({ hostPath, messages: [fileMsg('msg_1', url, 'photo.png', size)] })
    await expect(run(ctx, { filename: 'photo.png', destPath: 'link/evil.png' })).rejects.toThrow(
      'Path traversal',
    )
  })

  it('does not overwrite by default but does with overwrite:true', async () => {
    const { url, size } = makeSourceFile('NEW')
    const hostPath = makeVolume()
    writeFileSync(join(hostPath, 'photo.png'), 'OLD')
    const ctx = makeCtx({ hostPath, messages: [fileMsg('msg_1', url, 'photo.png', size)] })

    await expect(run(ctx, { filename: 'photo.png' })).rejects.toThrow('already exists')
    expect(readFileSync(join(hostPath, 'photo.png'), 'utf8')).toBe('OLD')

    const result: any = await run(ctx, { filename: 'photo.png', overwrite: true })
    expect(result.success).toBe(true)
    expect(readFileSync(join(hostPath, 'photo.png'), 'utf8')).toBe('NEW')
  })

  it('requires messageId to disambiguate multiple matches', async () => {
    const a = makeSourceFile('A')
    const b = makeSourceFile('B')
    const hostPath = makeVolume()
    const messages = [fileMsg('msg_1', a.url, 'dup.png', a.size), fileMsg('msg_2', b.url, 'dup.png', b.size)]
    const ctx = makeCtx({ hostPath, messages })

    await expect(run(ctx, { filename: 'dup.png' })).rejects.toThrow('Multiple attachments')

    const result: any = await run(ctx, { filename: 'dup.png', messageId: 'msg_2' })
    expect(result.success).toBe(true)
    expect(readFileSync(join(hostPath, 'dup.png'), 'utf8')).toBe('B')
  })

  it('matches filenames whose markdown chars were sanitized in the reference', async () => {
    const { url, size } = makeSourceFile('PAREN')
    const hostPath = makeVolume()
    // Stored original has parens; the agent only ever saw the sanitized label.
    const ctx = makeCtx({ hostPath, messages: [fileMsg('msg_1', url, 'foto (1).png', size)] })

    const result: any = await run(ctx, { filename: 'foto _1_.png' })
    expect(result.success).toBe(true)
    expect(existsSync(join(hostPath, 'foto (1).png'))).toBe(true)
  })

  it('throws when volume/workspace services are unavailable', async () => {
    const { url, size } = makeSourceFile()
    const hostPath = makeVolume()
    const ctx = makeCtx({ hostPath, messages: [fileMsg('msg_1', url, 'photo.png', size)], hasServices: false })
    await expect(run(ctx, { filename: 'photo.png' })).rejects.toThrow('unavailable')
  })
})
