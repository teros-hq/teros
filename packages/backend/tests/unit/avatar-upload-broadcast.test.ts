/**
 * Regression guard — TER-644 (handler wiring).
 *
 * El test hermano `agent-updated-broadcast.test.ts` fija el contrato de la lib
 * compartida (`buildAgentUpdatedPayload` / `broadcastAgentUpdated`). Pero esa lib
 * no sirve de nada si el path REST de subida de avatar no la LLAMA: borrar el
 * bloque de broadcast en `handleAvatarUpload` dejaba todos esos tests en verde y
 * reintroducía TER-644 sin que nadie se enterara.
 *
 * Este test conduce el handler REST de punta a punta —
 * `HttpUploadHandler.handleRoute` con un `POST /api/upload/avatar/:agentId`
 * multipart real— sobre un `db` falso, un `authService` falso y un
 * `pubSubService` espía, y afirma que se emite `agent.updated` con el avatarUrl
 * ya resuelto. El avatar se guarda como object de plataforma (OBJ-REQ-4) en un
 * directorio temporal; nada se escribe en packages/backend/static.
 *
 * Cubre además el invariante de robustez del fix: un broadcast que revienta NO
 * debe convertir una subida ya persistida en un 500.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../../src/config'
import { HttpUploadHandler } from '../../src/handlers/http-upload-handler'

const OBJ_PATH = mkdtempSync(join(tmpdir(), 'avatar-upload-broadcast-test-'))
const OBJECTS_BASE = `${config.agentApps.publicUrl.replace(/\/$/, '')}/objects/`

afterAll(() => {
  rmSync(OBJ_PATH, { recursive: true, force: true })
})

// --- Fakes -----------------------------------------------------------------

/** IncomingMessage falso: async-iterable con un cuerpo multipart de una imagen. */
function makeMultipartReq(opts: { boundary?: string; filename?: string; contentType?: string } = {}) {
  const boundary = opts.boundary ?? 'testboundary'
  const filename = opts.filename ?? 'pic.png'
  const contentType = opts.contentType ?? 'image/png'
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
    Buffer.from(`Content-Type: ${contentType}\r\n\r\n`),
    // Firma PNG real: el tipo se detecta por el contenido (OBJ-REQ-4).
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-token',
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    resume() {},
    async *[Symbol.asyncIterator]() {
      yield body
    },
  } as any
}

/** ServerResponse falso: captura status + body. */
function makeRes() {
  const captured = { status: 0, body: '' }
  return {
    captured,
    writeHead(status: number) {
      captured.status = status
    },
    end(body?: string) {
      if (body) captured.body = body
    },
  } as any
}

const AGENT_DOC = {
  agentId: 'agent:iria',
  coreId: 'core:iria',
  name: 'Iria',
  fullName: 'Iria Full',
  role: 'assistant',
  intro: 'hola',
  ownerId: 'user:1',
}

/** db falso cuya colección `agents` es controlable por test. */
function makeDb(overrides: {
  matchedCount?: number
  found?: Record<string, unknown> | null
} = {}) {
  const calls = { updateOne: [] as any[], findOne: [] as any[], insertOne: [] as any[] }
  const agents = {
    // Registro del object de plataforma (colección agent_app_objects).
    insertOne: async (doc: unknown) => {
      calls.insertOne.push(doc)
      return { acknowledged: true }
    },
    updateOne: async (filter: unknown, update: unknown) => {
      calls.updateOne.push({ filter, update })
      return { matchedCount: overrides.matchedCount ?? 1 }
    },
    findOne: async (filter: unknown) => {
      calls.findOne.push({ filter })
      if (overrides.found !== undefined) return overrides.found
      // Refleja lo que acaba de escribir updateOne (avatarUrl nuevo).
      return { ...AGENT_DOC, avatarUrl: 'obj_0123456789abcdef' }
    },
  }
  const db = { collection: () => agents } as any
  return { db, calls }
}

const authService = {
  validateSession: async () => ({ success: true, user: { userId: 'user:1' } }),
} as any

function makePubSubSpy(opts: { throwOnUser?: boolean } = {}) {
  const calls = { ws: [] as any[], user: [] as any[] }
  return {
    calls,
    pubSub: {
      broadcastToWorkspace: async (workspaceId: string, event: Record<string, unknown>) => {
        calls.ws.push({ workspaceId, event })
      },
      broadcastToUser: (userId: string, event: Record<string, unknown>) => {
        calls.user.push({ userId, event })
        if (opts.throwOnUser) throw new Error('pubsub down')
      },
    } as any,
  }
}

// --- Tests -----------------------------------------------------------------

describe('HttpUploadHandler · avatar upload → agent.updated (TER-644)', () => {
  let handled: boolean

  beforeEach(() => {
    handled = false
  })

  it('emite agent.updated con el avatarUrl resuelto tras subir el avatar', async () => {
    const { db, calls } = makeDb()
    const { calls: pub, pubSub } = makePubSubSpy()
    const handler = new HttpUploadHandler(db, authService, pubSub, OBJ_PATH)

    const res = makeRes()
    handled = await handler.handleRoute(
      makeMultipartReq(),
      res,
      '/api/upload/avatar/agent%3Airia',
    )

    expect(handled).toBe(true)
    expect(res.captured.status).toBe(200)
    // Persistió el id del object (no una URL absoluta, que producía
    // doble-wrapping y 404 al recargar), con el agente global como dueño.
    const persisted = calls.updateOne[0].update.$set.avatarUrl
    expect(persisted).toMatch(/^obj_[a-f0-9]{16}$/)
    expect(calls.insertOne[0]).toMatchObject({
      objectId: persisted,
      purpose: 'agent-avatar',
      agentId: 'agent:iria',
      userId: 'user:1',
      contentType: 'image/png',
    })
    // El broadcast es el corazón del fix: agente global → broadcastToUser.
    expect(pub.user).toHaveLength(1)
    expect(pub.user[0].event.type).toBe('agent.updated')
    expect(pub.user[0].event.agent.agentId).toBe('agent:iria')
    expect(pub.user[0].event.agent.avatarUrl).toBe(`${OBJECTS_BASE}obj_0123456789abcdef`)
  })

  it('un broadcast que revienta NO convierte la subida persistida en 500', async () => {
    const { db } = makeDb()
    const { pubSub } = makePubSubSpy({ throwOnUser: true })
    const handler = new HttpUploadHandler(db, authService, pubSub, OBJ_PATH)

    const res = makeRes()
    await handler.handleRoute(makeMultipartReq(), res, '/api/upload/avatar/agent%3Airia')

    expect(res.captured.status).toBe(200)
  })

  it('no emite agent.updated si el agente no existe (matchedCount 0 → 404)', async () => {
    const { db } = makeDb({ matchedCount: 0 })
    const { calls: pub, pubSub } = makePubSubSpy()
    const handler = new HttpUploadHandler(db, authService, pubSub, OBJ_PATH)

    const res = makeRes()
    await handler.handleRoute(makeMultipartReq(), res, '/api/upload/avatar/agent%3Airia')

    expect(res.captured.status).toBe(404)
    expect(pub.user).toHaveLength(0)
    expect(pub.ws).toHaveLength(0)
  })
})
