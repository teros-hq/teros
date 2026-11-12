/**
 * Regression guard — TER-644: cambiar el avatar de un agente debe refrescar el
 * panel de agentes SIN recargar.
 *
 * El avatar se sube por REST (`POST /api/upload/avatar/:agentId` →
 * `handleAvatarUpload`), un path DISTINTO al handler WS `agent.update`. El WS
 * emite `agent.updated` y el cliente (`useNavbarRealtimeSync`) lo consume para
 * hacer `updateAgent()`; el path REST NO emitía nada → el panel se quedaba con
 * el avatar viejo (mismo patrón que TER-611: mutación sin broadcast).
 *
 * El fix comparte la construcción del payload + el broadcast entre AMBOS paths
 * (`lib/agent-payload.ts`) para que no puedan divergir. Este test fija el scope
 * (workspace → broadcastToWorkspace, global → broadcastToUser) y la resolución
 * del avatarUrl. Borrar el broadcast, cambiar el scope o devolver el filename
 * crudo lo pone en rojo.
 */

import { describe, expect, it } from 'bun:test'
import { config } from '../../src/config'
import { broadcastAgentUpdated, buildAgentUpdatedPayload } from '../../src/lib/agent-payload'

const BASE = config.static.baseUrl

const baseAgent = {
  agentId: 'agent:iria',
  coreId: 'core:iria',
  name: 'Iria',
  fullName: 'Iria Full',
  role: 'assistant',
  intro: 'hola',
}

describe('buildAgentUpdatedPayload · avatarUrl', () => {
  it('resuelve el filename desnudo del agente con el static base', () => {
    const payload = buildAgentUpdatedPayload({
      ...baseAgent,
      avatarUrl: 'agent_iria-avatar-abcd1234.png',
    })
    expect(payload.avatarUrl).toBe(`${BASE}/agent_iria-avatar-abcd1234.png`)
  })

  it('cae al avatar del core cuando el agente no tiene avatar propio', () => {
    const payload = buildAgentUpdatedPayload({ ...baseAgent }, 'iria.png')
    expect(payload.avatarUrl).toBe(`${BASE}/iria.png`)
  })

  it('incluye los identificadores que el navbar necesita para el upsert', () => {
    const payload = buildAgentUpdatedPayload({ ...baseAgent, workspaceId: 'ws:1' })
    expect(payload.agentId).toBe('agent:iria')
    expect(payload.coreId).toBe('core:iria')
    expect(payload.workspaceId).toBe('ws:1')
  })
})

describe('broadcastAgentUpdated · scope', () => {
  function makeSpy() {
    const calls = { ws: [] as any[], user: [] as any[] }
    const pubSub = {
      broadcastToWorkspace: async (workspaceId: string, event: Record<string, unknown>) => {
        calls.ws.push({ workspaceId, event })
      },
      broadcastToUser: (userId: string, event: Record<string, unknown>) => {
        calls.user.push({ userId, event })
      },
    }
    return { calls, pubSub }
  }

  it('agente con workspace → broadcastToWorkspace(workspaceId, agent.updated)', async () => {
    const { calls, pubSub } = makeSpy()
    await broadcastAgentUpdated(
      pubSub,
      'user:1',
      buildAgentUpdatedPayload({ ...baseAgent, workspaceId: 'ws:42', avatarUrl: 'a-avatar-1.png' }),
    )
    expect(calls.user).toHaveLength(0)
    expect(calls.ws).toHaveLength(1)
    expect(calls.ws[0].workspaceId).toBe('ws:42')
    expect(calls.ws[0].event.type).toBe('agent.updated')
    expect(calls.ws[0].event.agent.agentId).toBe('agent:iria')
    expect(calls.ws[0].event.agent.avatarUrl).toBe(`${BASE}/a-avatar-1.png`)
  })

  it('agente global (sin workspace) → broadcastToUser(userId, agent.updated)', async () => {
    const { calls, pubSub } = makeSpy()
    await broadcastAgentUpdated(
      pubSub,
      'user:7',
      buildAgentUpdatedPayload({ ...baseAgent, avatarUrl: 'a-avatar-2.png' }),
    )
    expect(calls.ws).toHaveLength(0)
    expect(calls.user).toHaveLength(1)
    expect(calls.user[0].userId).toBe('user:7')
    expect(calls.user[0].event.type).toBe('agent.updated')
    expect(calls.user[0].event.agent.avatarUrl).toBe(`${BASE}/a-avatar-2.png`)
  })

  it('agente global sin userId → no emite (no hay a quién entregar)', async () => {
    const { calls, pubSub } = makeSpy()
    await broadcastAgentUpdated(pubSub, undefined, buildAgentUpdatedPayload({ ...baseAgent }))
    expect(calls.ws).toHaveLength(0)
    expect(calls.user).toHaveLength(0)
  })
})
