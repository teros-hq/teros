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
 * ya resuelto. `fs/promises` está mockeado para no tocar disco.
 *
 * Cubre además el invariante de robustez del fix: un broadcast que revienta NO
 * debe convertir una subida ya persistida en un 500.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'

// fs/promises mockeado ANTES de importar el handler: la subida hace mkdir +
// writeFile reales y no queremos ensuciar packages/backend/static en un unit
// test. Restauramos en afterAll porque mock.module persiste entre archivos del
// mismo proceso.
const realFsPromises = { ...(await import('fs/promises')) }
mock.module('fs/promises', () => ({
  ...realFsPromises,
  mkdir: async () => undefined,
  writeFile: async () => undefined,
}))

afterAll(() => {
  mock.module('fs/promises', () => realFsPromises)
})

const { HttpUploadHandler } = await import('../../src/handlers/http-upload-handler')
const { config } = await import('../../src/config')

const BASE = config.static.baseUrl

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
    Buffer.from([0x89, 0x50, 0x4e, 0x47]), // bytes PNG de mentira
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
  const calls = { updateOne: [] as any[], findOne: [] as any[] }
  const agents = {
    updateOne: async (filter: unknown, update: unknown) => {
      calls.updateOne.push({ filter, update })
      return { matchedCount: overrides.matchedCount ?? 1 }
    },
    findOne: async (filter: unknown) => {
      calls.findOne.push({ filter })
      if (overrides.found !== undefined) return overrides.found
      // Refleja lo que acaba de escribir updateOne (avatarUrl nuevo).
      return { ...AGENT_DOC, avatarUrl: 'agent_iria-avatar-abcd1234.png' }
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
    const handler = new HttpUploadHandler(db, authService, pubSub)

    const res = makeRes()
    handled = await handler.handleRoute(
      makeMultipartReq(),
      res,
      '/api/upload/avatar/agent%3Airia',
    )

    expect(handled).toBe(true)
    expect(res.captured.status).toBe(200)
    // Persistió el filename DESNUDO (no una URL absoluta): agentId saneado
    // (':' → '_') + sufijo uuid + extensión. Guardar la URL absoluta producía
    // doble-wrapping y 404 al recargar.
    const persisted = calls.updateOne[0].update.$set.avatarUrl
    expect(persisted).toMatch(/^agent_iria-avatar-[0-9a-f]{8}\.png$/)
    // El broadcast es el corazón del fix: agente global → broadcastToUser.
    expect(pub.user).toHaveLength(1)
    expect(pub.user[0].event.type).toBe('agent.updated')
    expect(pub.user[0].event.agent.agentId).toBe('agent:iria')
    expect(pub.user[0].event.agent.avatarUrl).toBe(`${BASE}/agent_iria-avatar-abcd1234.png`)
  })

  it('un broadcast que revienta NO convierte la subida persistida en 500', async () => {
    const { db } = makeDb()
    const { pubSub } = makePubSubSpy({ throwOnUser: true })
    const handler = new HttpUploadHandler(db, authService, pubSub)

    const res = makeRes()
    await handler.handleRoute(makeMultipartReq(), res, '/api/upload/avatar/agent%3Airia')

    expect(res.captured.status).toBe(200)
  })

  it('no emite agent.updated si el agente no existe (matchedCount 0 → 404)', async () => {
    const { db } = makeDb({ matchedCount: 0 })
    const { calls: pub, pubSub } = makePubSubSpy()
    const handler = new HttpUploadHandler(db, authService, pubSub)

    const res = makeRes()
    await handler.handleRoute(makeMultipartReq(), res, '/api/upload/avatar/agent%3Airia')

    expect(res.captured.status).toBe(404)
    expect(pub.user).toHaveLength(0)
    expect(pub.ws).toHaveLength(0)
  })
})
