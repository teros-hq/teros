/**
 * Regression de comportamiento (TER-607): los handlers admin-api.agents-list y
 * agents-get devuelven avatarUrl RESUELTO (URL pública), no el filename crudo.
 *
 * Complementa el lint-as-test (source-grep) verificando el runtime real: si la
 * resolución se revierte, el handler devolvería `iria-avatar.jpg` en vez de
 * `<base>/iria-avatar.jpg` y estos toBe caen.
 */

import { describe, expect, it } from 'bun:test'
import type { WsHandlerContext } from '@teros/shared'
import { config } from '../../src/config'
import {
  createAgentsGetHandler,
  createAgentsListHandler,
} from '../../src/handlers/domains/admin-api/agents'

const ctx = (userId: string): WsHandlerContext =>
  ({ userId, sessionId: 's', connectionId: 'c' }) as any

function mockDb(opts: { agents: any[]; cores: any[]; userRole?: string }) {
  return {
    collection(name: string) {
      if (name === 'users') {
        return { findOne: async () => ({ role: opts.userRole ?? 'admin' }) }
      }
      if (name === 'agents') {
        return {
          find: () => ({ toArray: async () => opts.agents }),
          findOne: async (q: any) => opts.agents.find((a) => a.agentId === q.agentId) ?? null,
        }
      }
      if (name === 'agent_cores') {
        return {
          find: () => ({ toArray: async () => opts.cores }),
          findOne: async (q: any) => opts.cores.find((c) => c.coreId === q.coreId) ?? null,
        }
      }
      throw new Error(`unexpected collection ${name}`)
    },
  } as any
}

const expectedUrl = (file: string) => `${config.static.baseUrl}/${file}`

describe('admin-api.agents-list · resuelve avatarUrl', () => {
  it('devuelve la URL pública, no el filename crudo', async () => {
    const db = mockDb({
      agents: [{ agentId: 'agent_1', name: 'Iria', coreId: 'agent', avatarUrl: 'iria-avatar.jpg' }],
      cores: [],
    })
    const res: any = await createAgentsListHandler(db)(ctx('admin1'), {})
    expect(res.agents[0].avatarUrl).toBe(expectedUrl('iria-avatar.jpg'))
    expect(res.agents[0].avatarUrl).not.toBe('iria-avatar.jpg')
    // Forma observable independiente de config (caza separador doble / clave errónea
    // que un esperado recomputado vía config no distinguiría).
    expect(res.agents[0].avatarUrl).toMatch(/^https?:\/\/[^?]+\/iria-avatar\.jpg$/)
  })

  it('cae al avatar del core cuando el agente no tiene, y también lo resuelve', async () => {
    const db = mockDb({
      agents: [{ agentId: 'agent_2', name: 'X', coreId: 'agent' }],
      cores: [{ coreId: 'agent', avatarUrl: 'luna-avatar.jpg' }],
    })
    const res: any = await createAgentsListHandler(db)(ctx('admin1'), {})
    expect(res.agents[0].avatarUrl).toBe(expectedUrl('luna-avatar.jpg'))
  })
})

describe('admin-api.agents-get · resuelve avatarUrl', () => {
  it('devuelve la URL pública resuelta', async () => {
    const db = mockDb({
      agents: [{ agentId: 'agent_1', name: 'Iria', coreId: 'agent', avatarUrl: 'iria-avatar.jpg' }],
      cores: [{ coreId: 'agent', avatarUrl: 'iria-avatar.jpg' }],
    })
    const res: any = await createAgentsGetHandler(db)(ctx('admin1'), { agentId: 'agent_1' })
    expect(res.avatarUrl).toBe(expectedUrl('iria-avatar.jpg'))
    expect(res.avatarUrl).not.toBe('iria-avatar.jpg')
    expect(res.avatarUrl).toMatch(/^https?:\/\/[^?]+\/iria-avatar\.jpg$/)
  })

  it('una URL absoluta ya almacenada pasa sin doble-wrap (idempotencia)', async () => {
    const abs = 'https://cdn.example.com/avatars/x.png'
    const db = mockDb({
      agents: [{ agentId: 'agent_3', name: 'Y', coreId: 'agent', avatarUrl: abs }],
      cores: [],
    })
    const res: any = await createAgentsGetHandler(db)(ctx('admin1'), { agentId: 'agent_3' })
    expect(res.avatarUrl).toBe(abs)
  })
})
