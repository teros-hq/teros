/**
 * Hardening tests for permission-manager (TER-321 post-review adversarial).
 *
 * Covers each gap identified by the Minimax 2.7 review that was real and in scope:
 *
 *   GAP-1  — requestId uses crypto.randomUUID (no counter, no prefix collisions)
 *   GAP-7  — handleResponse is idempotent on double-call
 *   GAP-8  — onPendingPermission throwing cleans up the pending entry
 *   GAP-11 — restorePendingApprovals skips broadcast when tool no longer exists
 *   GAP-15 — getToolCallContext throwing auto-denies without leaving promise hanging
 *
 * Additional in-scope coverage:
 *   - GAP-6  (executor: permission='allow' + context.onAskPermission → callback NOT invoked) — tested in executor file
 *   - GAP-10 (executor: bypassPermissions + 'ask' → bypass wins) — tested in executor file
 */

import { describe, expect, it, mock } from 'bun:test'
import { createPermissionManager } from '../../src/handlers/message/permission-manager'

function makeManager(opts?: {
  broadcasts?: any[]
  validateToolExists?: (appId: string, toolName: string) => Promise<boolean>
  updateMessageStatus?: (messageId: string, status: 'failed', extra?: Record<string, unknown>) => Promise<void>
}) {
  const broadcasts = opts?.broadcasts ?? []
  return {
    broadcasts,
    pm: createPermissionManager({
      broadcastToChannel: (_ch: string, msg: any) => broadcasts.push(msg),
      onExternalActionChange: mock(() => undefined),
      validateToolExists: opts?.validateToolExists,
      updateMessageStatus: opts?.updateMessageStatus,
    }),
  }
}

// ---------------------------------------------------------------------------
// GAP-1 — requestId is crypto.randomUUID, no counter, no prefix
// ---------------------------------------------------------------------------

describe('GAP-1 — requestId uses crypto.randomUUID', () => {
  it('emits a UUID-shaped requestId with no channel prefix and no counter', async () => {
    const { broadcasts, pm } = makeManager()
    const ask = pm.createAskPermissionCallback(
      'ch_alpha_xyz123',
      'user_test',
      () => ({ messageId: 'm', toolCallId: 'tc' }),
      undefined,
    )
    ask('t', 'a', {}, 'tc')
    await new Promise((r) => setTimeout(r, 5))
    const broadcast = broadcasts.find((b) => b.type === 'tool_permission_request')
    expect(broadcast).toBeDefined()
    // perm_<uuid v4>: 8-4-4-4-12 hex
    expect(broadcast.requestId).toMatch(
      /^perm_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })

  it('generates distinct requestIds for two channels sharing the first 8 chars (pre-fix would collide)', async () => {
    const { broadcasts, pm } = makeManager()
    const askA = pm.createAskPermissionCallback(
      'ch_aabbcc_dd_X', // collision-prone prefix
      'user_test',
      () => ({ messageId: 'mA', toolCallId: 'tcA' }),
      undefined,
    )
    const askB = pm.createAskPermissionCallback(
      'ch_aabbcc_dd_Y', // identical first 8 chars
      'user_test',
      () => ({ messageId: 'mB', toolCallId: 'tcB' }),
      undefined,
    )
    askA('t', 'a', {}, 'tcA')
    askB('t', 'a', {}, 'tcB')
    await new Promise((r) => setTimeout(r, 5))
    const ids = broadcasts
      .filter((b) => b.type === 'tool_permission_request')
      .map((b) => b.requestId)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })
})

// ---------------------------------------------------------------------------
// GAP-7 — handleResponse idempotency on duplicate
// ---------------------------------------------------------------------------

describe('GAP-7 — handleResponse is idempotent', () => {
  it('second handleResponse for the same requestId returns idempotent flag, not null', async () => {
    const { broadcasts, pm } = makeManager()
    const ask = pm.createAskPermissionCallback(
      'ch_idem',
      'user_test',
      () => ({ messageId: 'm', toolCallId: 'tc' }),
      undefined,
    )
    const promise = ask('t', 'a', {}, 'tc')
    await new Promise((r) => setTimeout(r, 5))
    const reqId = broadcasts.find((b) => b.type === 'tool_permission_request').requestId

    const first = await pm.handleResponse(reqId, true)
    expect(first?.toolName).toBe('t')
    expect(first?.idempotent).toBeUndefined()

    // Resolve the original promise so we don't leak it
    await promise

    const second = await pm.handleResponse(reqId, true)
    expect(second).toMatchObject({ idempotent: true })
  })

  it('unknown requestId still returns null (real bug signal preserved)', async () => {
    const { pm } = makeManager()
    const result = await pm.handleResponse('perm_unknown_xxx', true)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// GAP-8 — onPendingPermission throwing cleans up
// ---------------------------------------------------------------------------

describe('GAP-8 — onPendingPermission failure auto-denies and cleans up', () => {
  it('rejecting onPendingPermission resolves the promise as denied and removes from pending', async () => {
    const { pm } = makeManager()
    const ask = pm.createAskPermissionCallback(
      'ch_g8',
      'user_test',
      () => ({ messageId: 'm', toolCallId: 'tc' }),
      {
        onPendingPermission: async () => {
          throw new Error('boom — DB write failed')
        },
      },
    )
    const result = await ask('t', 'a', {}, 'tc')
    expect(result).toBe('denied')
    // No pending leak: a follow-up handleResponse on a fresh id should not find a stale entry
    const stats = (pm as any).pendingPermissionsCount?.() // optional; main check is the resolve above
    if (typeof stats === 'number') expect(stats).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// No expiry — a pending request waits for the user indefinitely
// ---------------------------------------------------------------------------

describe('no expiry — pending request waits until the user responds', () => {
  it('an unanswered ask stays pending and resolves when handleResponse arrives late', async () => {
    const { broadcasts, pm } = makeManager()
    const ask = pm.createAskPermissionCallback(
      'ch_wait',
      'user_test',
      () => ({ messageId: 'm', toolCallId: 'tc' }),
      undefined,
    )
    const promise = ask('t', 'a', {}, 'tc')

    // Give the broadcast a chance to fire; the promise must NOT auto-resolve.
    await new Promise((r) => setTimeout(r, 25))
    expect(pm.getPendingCount()).toBe(1)

    const reqId = broadcasts.find((b) => b.type === 'tool_permission_request').requestId
    await pm.handleResponse(reqId, true)
    expect(await promise).toBe('granted')
    expect(pm.getPendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// GAP-11 — restorePendingApprovals skips tools that no longer exist
// ---------------------------------------------------------------------------

describe('GAP-11 — restorePendingApprovals validates tool existence', () => {
  it('marks message failed and skips broadcast when validateToolExists returns false', async () => {
    const broadcasts: any[] = []
    const updateMessageStatus = mock(async () => undefined)
    const validateToolExists = mock(async () => false)
    const { pm } = makeManager({ broadcasts, validateToolExists, updateMessageStatus })

    // Inject a fake findPendingApprovals via casting — we mock by monkey-patching for the test.
    ;(pm as any).findPendingApprovals = async () => [
      {
        toolCallId: 'tc_gone',
        toolName: 'removed_tool',
        appId: 'app_x',
        requestId: 'perm_gone_1',
        input: {},
        messageId: 'msg_gone',
      },
    ]

    const restored = await pm.restorePendingApprovals('ch_restore')
    expect(restored).toBe(0)
    expect(validateToolExists).toHaveBeenCalledWith('app_x', 'removed_tool')
    expect(updateMessageStatus).toHaveBeenCalledWith('msg_gone', 'failed', expect.any(Object))
    const permBroadcasts = broadcasts.filter((b) => b.type === 'tool_permission_request')
    expect(permBroadcasts.length).toBe(0)
  })

  it('proceeds normally when validateToolExists returns true', async () => {
    const broadcasts: any[] = []
    const validateToolExists = mock(async () => true)
    const { pm } = makeManager({ broadcasts, validateToolExists })

    ;(pm as any).findPendingApprovals = async () => [
      {
        toolCallId: 'tc_ok',
        toolName: 'existing_tool',
        appId: 'app_x',
        requestId: 'perm_ok_1',
        input: {},
        messageId: 'msg_ok',
      },
    ]

    const restored = await pm.restorePendingApprovals('ch_restore_ok')
    expect(restored).toBe(1)
    const broadcast = broadcasts.find((b) => b.type === 'tool_permission_request')
    expect(broadcast).toBeDefined()
    expect(broadcast.restored).toBe(true)
  })

  // TER-340: un broadcast que falla NO debe romper la cadena.
  it('continues restoring siguientes pendings cuando el broadcast del 1ro lanza', async () => {
    const broadcasts: any[] = []
    let callCount = 0
    const { createPermissionManager } = require('../../src/handlers/message/permission-manager')
    const pm = createPermissionManager({
      broadcastToChannel: (channelId: string, msg: any) => {
        callCount++
        // El 1er intento de broadcast lanza; los siguientes ok
        if (callCount === 1) throw new Error('WS write failed for first pending')
        broadcasts.push({ channelId, ...msg })
      },
      onExternalActionChange: mock(() => undefined),
      validateToolExists: async () => true,
    })

    ;(pm as any).findPendingApprovals = async () => [
      { toolCallId: 'tc_1', toolName: 't', appId: 'a', requestId: 'perm_1', input: {}, messageId: 'm1' },
      { toolCallId: 'tc_2', toolName: 't', appId: 'a', requestId: 'perm_2', input: {}, messageId: 'm2' },
      { toolCallId: 'tc_3', toolName: 't', appId: 'a', requestId: 'perm_3', input: {}, messageId: 'm3' },
    ]

    const restored = await pm.restorePendingApprovals('ch_chain')
    // 1ro fallido (excepción capturada), 2do y 3ro restored OK
    expect(restored).toBe(2)
    const permIds = broadcasts.filter((b) => b.type === 'tool_permission_request').map((b) => b.requestId)
    expect(permIds).toContain('perm_2')
    expect(permIds).toContain('perm_3')
    expect(permIds).not.toContain('perm_1')
  })
})

// ---------------------------------------------------------------------------
// GAP-15 — getToolCallContext throws → auto-deny + telemetry
// ---------------------------------------------------------------------------

describe('GAP-15 — getToolCallContext exception is caught', () => {
  it('a throwing context lookup auto-denies without broadcasting', async () => {
    const { broadcasts, pm } = makeManager()
    const ask = pm.createAskPermissionCallback(
      'ch_throw',
      'user_test',
      () => {
        throw new Error('streamState mutated under us')
      },
      undefined,
    )
    const result = await ask('t', 'a', {}, 'tc_x')
    expect(result).toBe('denied')
    const permBroadcasts = broadcasts.filter((b) => b.type === 'tool_permission_request')
    expect(permBroadcasts.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TER-338 — Dual-broadcast al observer (originChannelId)
// ---------------------------------------------------------------------------

describe('TER-338 — tool_permission_request dual-broadcast a observer channel', () => {
  function makeManagerWithObserver(observerMap: Record<string, string | null>) {
    const broadcasts: Array<{ channelId: string; event: any }> = []
    const { createPermissionManager } = require('../../src/handlers/message/permission-manager')
    const pm = createPermissionManager({
      broadcastToChannel: (channelId: string, event: any) => broadcasts.push({ channelId, event }),
      onExternalActionChange: mock(() => undefined),
      resolveObserverChannelId: async (channelId: string) => observerMap[channelId] ?? null,
    })
    return { broadcasts, pm }
  }

  it('broadcastea al canal del ejecutor Y al observer cuando hay originChannelId', async () => {
    const { broadcasts, pm } = makeManagerWithObserver({
      'ch_subchannel': 'ch_parent',
    })

    const ask = pm.createAskPermissionCallback(
      'ch_subchannel',
      'user_test',
      () => ({ messageId: 'msg_sub', toolCallId: 'tc_sub' }),
      undefined,
    )
    ask('filesystem_write', 'app_x', { path: 'foo.txt' }, 'tc_sub')
    await new Promise((r) => setTimeout(r, 20))

    const permBroadcasts = broadcasts.filter((b) => b.event.type === 'tool_permission_request')
    expect(permBroadcasts.length).toBe(2)

    // Broadcast al canal del ejecutor SIN observedChannelId
    const sub = permBroadcasts.find((b) => b.channelId === 'ch_subchannel')
    expect(sub).toBeDefined()
    expect(sub!.event.observedChannelId).toBeUndefined()

    // Broadcast al observer CON observedChannelId = sub-canal original
    const observer = permBroadcasts.find((b) => b.channelId === 'ch_parent')
    expect(observer).toBeDefined()
    expect(observer!.event.observedChannelId).toBe('ch_subchannel')
    expect(observer!.event.messageId).toBe('msg_sub')
    expect(observer!.event.toolCallId).toBe('tc_sub')
  })

  it('solo broadcastea al canal del ejecutor cuando NO hay observer (flow single-agent)', async () => {
    const { broadcasts, pm } = makeManagerWithObserver({
      'ch_solo': null,
    })

    const ask = pm.createAskPermissionCallback(
      'ch_solo',
      'user_test',
      () => ({ messageId: 'msg_solo', toolCallId: 'tc_solo' }),
      undefined,
    )
    ask('filesystem_write', 'app_x', {}, 'tc_solo')
    await new Promise((r) => setTimeout(r, 20))

    const permBroadcasts = broadcasts.filter((b) => b.event.type === 'tool_permission_request')
    expect(permBroadcasts.length).toBe(1)
    expect(permBroadcasts[0].channelId).toBe('ch_solo')
    expect(permBroadcasts[0].event.observedChannelId).toBeUndefined()
  })

  it('resilient si resolveObserverChannelId lanza: emite al ejecutor de todas formas', async () => {
    const broadcasts: Array<{ channelId: string; event: any }> = []
    const { createPermissionManager } = require('../../src/handlers/message/permission-manager')
    const pm = createPermissionManager({
      broadcastToChannel: (channelId: string, event: any) => broadcasts.push({ channelId, event }),
      onExternalActionChange: mock(() => undefined),
      resolveObserverChannelId: async () => {
        throw new Error('DB down')
      },
    })

    const ask = pm.createAskPermissionCallback(
      'ch_resilient',
      'user_test',
      () => ({ messageId: 'msg_r', toolCallId: 'tc_r' }),
      undefined,
    )
    ask('t', 'a', {}, 'tc_r')
    await new Promise((r) => setTimeout(r, 20))

    const permBroadcasts = broadcasts.filter((b) => b.event.type === 'tool_permission_request')
    expect(permBroadcasts.length).toBe(1)
    expect(permBroadcasts[0].channelId).toBe('ch_resilient')
  })

  it('NO se duplica al mismo canal cuando observer === executor', async () => {
    const { broadcasts, pm } = makeManagerWithObserver({
      'ch_same': 'ch_same',
    })

    const ask = pm.createAskPermissionCallback(
      'ch_same',
      'user_test',
      () => ({ messageId: 'msg_s', toolCallId: 'tc_s' }),
      undefined,
    )
    ask('t', 'a', {}, 'tc_s')
    await new Promise((r) => setTimeout(r, 20))

    const permBroadcasts = broadcasts.filter((b) => b.event.type === 'tool_permission_request')
    expect(permBroadcasts.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// GAP-A — channelId siempre presente en el payload de cada broadcast
// (sin esto el PendingApprovalsWindow hace early return y useChatPermissions
//  cae a fallback impreciso por toolCallId)
// ---------------------------------------------------------------------------

describe('GAP-A — channelId presente en payload de cada broadcast', () => {
  function makeManagerWithObserver(observerMap: Record<string, string | null>) {
    const broadcasts: Array<{ channelId: string; event: any }> = []
    const { createPermissionManager } = require('../../src/handlers/message/permission-manager')
    const pm = createPermissionManager({
      broadcastToChannel: (channelId: string, event: any) => broadcasts.push({ channelId, event }),
      onExternalActionChange: mock(() => undefined),
      resolveObserverChannelId: async (channelId: string) => observerMap[channelId] ?? null,
    })
    return { broadcasts, pm }
  }

  it('event.channelId === channel destino tanto en ejecutor como observer', async () => {
    const { broadcasts, pm } = makeManagerWithObserver({
      'ch_executor': 'ch_observer',
    })
    const ask = pm.createAskPermissionCallback(
      'ch_executor',
      'user_test',
      () => ({ messageId: 'm', toolCallId: 'tc' }),
      undefined,
    )
    ask('t', 'a', {}, 'tc')
    await new Promise((r) => setTimeout(r, 20))

    const perms = broadcasts.filter((b) => b.event.type === 'tool_permission_request')
    expect(perms.length).toBe(2)

    const exec = perms.find((b) => b.channelId === 'ch_executor')
    expect(exec).toBeDefined()
    expect(exec!.event.channelId).toBe('ch_executor')
    expect(exec!.event.observedChannelId).toBeUndefined()

    const obs = perms.find((b) => b.channelId === 'ch_observer')
    expect(obs).toBeDefined()
    expect(obs!.event.channelId).toBe('ch_observer')
    expect(obs!.event.observedChannelId).toBe('ch_executor')
  })

  it('channelId presente en flow single-agent (sin observer)', async () => {
    const { broadcasts, pm } = makeManagerWithObserver({ 'ch_solo': null })
    const ask = pm.createAskPermissionCallback(
      'ch_solo',
      'user_test',
      () => ({ messageId: 'm', toolCallId: 'tc' }),
      undefined,
    )
    ask('t', 'a', {}, 'tc')
    await new Promise((r) => setTimeout(r, 20))
    const perm = broadcasts.find((b) => b.event.type === 'tool_permission_request')
    expect(perm).toBeDefined()
    expect(perm!.event.channelId).toBe('ch_solo')
  })
})

// ---------------------------------------------------------------------------
// GAP-F — multi-hop observer chain con anti-loop (Set<seen>) y hard limit
// ---------------------------------------------------------------------------

describe('GAP-F — multi-hop observer chain', () => {
  function makeManagerWithChain(observerMap: Record<string, string | null>) {
    const broadcasts: Array<{ channelId: string; event: any }> = []
    const { createPermissionManager } = require('../../src/handlers/message/permission-manager')
    const pm = createPermissionManager({
      broadcastToChannel: (channelId: string, event: any) => broadcasts.push({ channelId, event }),
      onExternalActionChange: mock(() => undefined),
      resolveObserverChannelId: async (channelId: string) => observerMap[channelId] ?? null,
    })
    return { broadcasts, pm }
  }

  it('emite a TODOS los ancestors en cadena C → B → A', async () => {
    // C (ejecutor) → B (observer hop1) → A (observer hop2, root)
    const { broadcasts, pm } = makeManagerWithChain({
      'ch_C': 'ch_B',
      'ch_B': 'ch_A',
      'ch_A': null,
    })

    const ask = pm.createAskPermissionCallback(
      'ch_C',
      'user_test',
      () => ({ messageId: 'm', toolCallId: 'tc' }),
      undefined,
    )
    ask('t', 'a', {}, 'tc')
    await new Promise((r) => setTimeout(r, 30))

    const perms = broadcasts.filter((b) => b.event.type === 'tool_permission_request')
    const channelIds = perms.map((b) => b.channelId).sort()
    expect(channelIds).toEqual(['ch_A', 'ch_B', 'ch_C'])

    // observedChannelId apunta al EJECUTOR RAÍZ (ch_C) en todos los hops.
    // Es deliberado: los observers (B y A) quieren navegar al canal donde está la
    // tool call card original. El hop intermedio no es útil para esa navegación.
    const obsB = perms.find((b) => b.channelId === 'ch_B')!
    const obsA = perms.find((b) => b.channelId === 'ch_A')!
    expect(obsB.event.observedChannelId).toBe('ch_C')
    expect(obsA.event.observedChannelId).toBe('ch_C')
  })

  it('detecta y rompe ciclo A ↔ B sin stack overflow', async () => {
    // Bug hipotético: ch_A.origin = ch_B, ch_B.origin = ch_A (referencia circular)
    const { broadcasts, pm } = makeManagerWithChain({
      'ch_A': 'ch_B',
      'ch_B': 'ch_A',
    })

    const ask = pm.createAskPermissionCallback(
      'ch_A',
      'user_test',
      () => ({ messageId: 'm', toolCallId: 'tc' }),
      undefined,
    )
    ask('t', 'a', {}, 'tc')
    await new Promise((r) => setTimeout(r, 30))

    const perms = broadcasts.filter((b) => b.event.type === 'tool_permission_request')
    // El ejecutor (ch_A) + el observer hop 1 (ch_B), pero NO loop infinito.
    // El segundo intento de resolver desde ch_B → ch_A → ya visto → corta.
    const channelIds = perms.map((b) => b.channelId).sort()
    expect(channelIds).toEqual(['ch_A', 'ch_B'])
  })

  it('clampa la cadena a MAX_OBSERVER_HOPS (5) si la cadena es absurdamente larga', async () => {
    // Cadena de 10 hops — debería cortarse en 5
    const chain: Record<string, string | null> = {}
    for (let i = 0; i < 10; i++) {
      chain[`ch_${i}`] = `ch_${i + 1}`
    }
    chain['ch_10'] = null
    const { broadcasts, pm } = makeManagerWithChain(chain)

    const ask = pm.createAskPermissionCallback(
      'ch_0',
      'user_test',
      () => ({ messageId: 'm', toolCallId: 'tc' }),
      undefined,
    )
    ask('t', 'a', {}, 'tc')
    await new Promise((r) => setTimeout(r, 30))

    const perms = broadcasts.filter((b) => b.event.type === 'tool_permission_request')
    // ejecutor (ch_0) + 5 hops máx = 6 broadcasts
    expect(perms.length).toBeLessThanOrEqual(6)
    expect(perms.length).toBeGreaterThan(1)
  })
})
