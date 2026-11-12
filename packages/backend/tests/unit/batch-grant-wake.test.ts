/**
 * PERMB-REQ-3 — each decision settles its request; the agent wakes once per
 * batch.
 *
 * Since PERMB-REQ-1 every ask of a step is registered before the turn ends, so
 * a channel can hold N pending requests at once. Each grant executes its tool
 * and rewrites its session part; each deny rewrites its session part as an
 * error result. Neither wakes by itself: the agent wakes ONCE, when the
 * channel has no pending request left and every resolution finished, with
 * every outcome named in the wake text.
 *
 * The PermissionManager is built with fakes (no Mongo): the batch logic is
 * in-memory; expirePermission only needs a `channel_messages.updateOne`.
 * The MessageHandler pieces (executeRestoredTool, updateSessionToolPartResult,
 * applyToolPermissionToPendingRequests) are invoked through the prototype with
 * a minimal `this` — same pattern as grant-path-session-tool-result.test.ts.
 */

import { describe, expect, it, mock } from 'bun:test'
import { MessageHandler } from '../../src/handlers/message-handler'
import {
  buildPermissionBatchWakeText,
  createPermissionManager,
  type PermissionBatchOutcome,
} from '../../src/handlers/message/permission-manager'

const CHANNEL = 'ch_permb'

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function makeFakeDb() {
  const updates: Array<{ filter: any; update: any }> = []
  return {
    updates,
    db: {
      collection: () => ({
        updateOne: async (filter: any, update: any) => {
          updates.push({ filter, update })
          return { modifiedCount: 1 }
        },
        find: () => ({ toArray: async () => [] }),
        findOne: async () => null,
      }),
    } as any,
  }
}

function makeBatch() {
  const wakes: Array<{ channelId: string; outcomes: PermissionBatchOutcome[] }> = []
  const deniedRewrites: any[] = []
  const { db, updates } = makeFakeDb()
  const pm = createPermissionManager({
    broadcastToChannel: () => {},
    db,
    onBatchResolved: async (args) => {
      wakes.push(args)
    },
    rewriteDeniedToolPart: async (args) => {
      deniedRewrites.push(args)
    },
  })
  const ask = pm.createAskPermissionCallback(
    CHANNEL,
    'user_1',
    (toolCallId?: string) =>
      toolCallId ? { messageId: `msg_${toolCallId}`, toolCallId, toolName: 'x' } : null,
    undefined,
    'work_1',
  )
  async function request(toolName: string, toolCallId: string): Promise<string> {
    const r: any = await ask(toolName, 'app_x', { n: toolCallId }, false, toolCallId)
    expect(r.kind).toBe('requested')
    return r.requestId
  }
  return { pm, wakes, deniedRewrites, updates, request }
}

describe('PermissionManager — one wake per batch (PERMB-REQ-3)', () => {
  it('[PERMB-AC-3] two pendings: granting the first executes it and does not wake; denying the second wakes once naming both', async () => {
    const { pm, wakes, deniedRewrites, request } = makeBatch()
    const a = await request('x_alpha', 'tc_a')
    const b = await request('x_beta', 'tc_b')

    const executed: any[] = []
    await pm.handleResponse(a, true, async (args) => {
      executed.push(args)
    })
    await tick()
    expect(executed).toHaveLength(1)
    expect(executed[0]).toMatchObject({ toolCallId: 'tc_a', toolName: 'x_alpha', input: { n: 'tc_a' } })
    // b is still pending — the batch is not complete.
    expect(wakes).toHaveLength(0)

    await pm.handleResponse(b, false, async () => {
      throw new Error('a deny never executes')
    })
    await tick()
    // The deny rewrote the session part with the denial as an error result.
    expect(deniedRewrites).toEqual([
      {
        channelId: CHANNEL,
        toolCallId: 'tc_b',
        toolName: 'x_beta',
        output: "Permission denied: User declined to allow execution of 'x_beta'.",
      },
    ])
    // ONE wake, both outcomes.
    expect(wakes).toHaveLength(1)
    expect(wakes[0].outcomes).toEqual([
      { toolName: 'x_alpha', outcome: 'granted' },
      { toolName: 'x_beta', outcome: 'denied' },
    ])
  })

  it('[PERMB-AC-3] the wake waits for a grant still executing when the last request is decided', async () => {
    const { pm, wakes, request } = makeBatch()
    const a = await request('x_alpha', 'tc_a')
    const b = await request('x_beta', 'tc_b')

    const slow = deferred()
    await pm.handleResponse(a, true, async () => {
      await slow.promise
    })
    await pm.handleResponse(b, false)
    await tick()
    // Nothing pending, but the grant of a is still executing → no wake yet.
    expect(wakes).toHaveLength(0)

    slow.resolve()
    await tick()
    expect(wakes).toHaveLength(1)
    expect(wakes[0].outcomes.map((o) => o.outcome).sort()).toEqual(['denied', 'granted'])
  })

  it('[PERMB-AC-3] concurrent grants (Allow all) wake exactly once', async () => {
    const { pm, wakes, request } = makeBatch()
    const ids = [await request('x_a', 'tc_1'), await request('x_b', 'tc_2'), await request('x_c', 'tc_3')]
    const gates = ids.map(() => deferred())

    // Fired back to back, as N WS requests would be.
    await Promise.all(ids.map((id, i) => pm.handleResponse(id, true, async () => gates[i].promise)))
    // Finish in reverse order.
    gates[2].resolve()
    await tick()
    gates[1].resolve()
    await tick()
    expect(wakes).toHaveLength(0)
    gates[0].resolve()
    await tick()

    expect(wakes).toHaveLength(1)
    expect(wakes[0].outcomes).toHaveLength(3)
    expect(wakes[0].outcomes.every((o) => o.outcome === 'granted')).toBe(true)
  })

  it('[PERMB-AC-3] granted tools execute one at a time per channel, in decision order', async () => {
    const { pm, wakes, request } = makeBatch()
    const ids = [await request('x_a', 'tc_1'), await request('x_b', 'tc_2'), await request('x_c', 'tc_3')]
    const gates = ids.map(() => deferred())
    const started: string[] = []
    const finished: string[] = []

    await Promise.all(
      ids.map((id, i) =>
        pm.handleResponse(id, true, async ({ toolCallId }) => {
          started.push(toolCallId)
          await gates[i].promise
          finished.push(toolCallId)
        }),
      ),
    )
    await tick()
    // Only the first execution has started: the others wait their turn.
    expect(started).toEqual(['tc_1'])
    gates[0].resolve()
    await tick()
    expect(started).toEqual(['tc_1', 'tc_2'])
    expect(finished).toEqual(['tc_1'])
    gates[1].resolve()
    await tick()
    expect(started).toEqual(['tc_1', 'tc_2', 'tc_3'])
    gates[2].resolve()
    await tick()
    expect(finished).toEqual(['tc_1', 'tc_2', 'tc_3'])
    expect(wakes).toHaveLength(1)
  })

  it('[PERMB-AC-3] a failed execution does not block the next grant of the channel', async () => {
    const { pm, wakes, request } = makeBatch()
    const ids = [await request('x_a', 'tc_1'), await request('x_b', 'tc_2')]
    const started: string[] = []
    await Promise.all(
      ids.map((id) =>
        pm.handleResponse(id, true, async ({ toolCallId }) => {
          started.push(toolCallId)
          if (toolCallId === 'tc_1') throw new Error('boom')
        }),
      ),
    )
    await tick()
    expect(started).toEqual(['tc_1', 'tc_2'])
    expect(wakes).toHaveLength(1)
    expect(wakes[0].outcomes.map((o) => o.outcome)).toEqual(['granted_not_executed', 'granted'])
  })

  it('[PERMB-AC-3] a single request wakes right after its decision', async () => {
    const { pm, wakes, request } = makeBatch()
    const a = await request('x_alpha', 'tc_a')
    await pm.handleResponse(a, true, async () => {})
    await tick()
    expect(wakes).toEqual([{ channelId: CHANNEL, outcomes: [{ toolName: 'x_alpha', outcome: 'granted' }] }])
  })

  it('[PERMB-AC-3] a grant whose execution throws is reported as approved-not-executed (still one wake)', async () => {
    const { pm, wakes, request } = makeBatch()
    const a = await request('x_alpha', 'tc_a')
    await pm.handleResponse(a, true, async () => {
      throw new Error('executor unavailable')
    })
    await tick()
    expect(wakes).toHaveLength(1)
    expect(wakes[0].outcomes).toEqual([{ toolName: 'x_alpha', outcome: 'granted_not_executed' }])
  })

  it('[PERMB-AC-3] expiry of the last pending wakes when another request of the batch was decided', async () => {
    const { pm, wakes, request } = makeBatch()
    const a = await request('x_alpha', 'tc_a')
    const b = await request('x_beta', 'tc_b')

    await pm.handleResponse(a, false)
    await tick()
    expect(wakes).toHaveLength(0)

    await pm.expirePermission('msg_tc_b', b, CHANNEL)
    await tick()
    expect(wakes).toHaveLength(1)
    expect(wakes[0].outcomes).toEqual([
      { toolName: 'x_alpha', outcome: 'denied' },
      { toolName: 'x_beta', outcome: 'expired' },
    ])
  })

  it('[PERMB-AC-3] expiry never wakes when no request of the batch was decided', async () => {
    const { pm, wakes, request } = makeBatch()
    const a = await request('x_alpha', 'tc_a')
    const b = await request('x_beta', 'tc_b')

    await pm.expirePermission('msg_tc_a', a, CHANNEL)
    await pm.expirePermission('msg_tc_b', b, CHANNEL)
    await tick()
    expect(wakes).toHaveLength(0)
    expect(pm.getPendingCount()).toBe(0)
  })

  it('[PERMB-AC-3] an expiry that is not the last pending does not wake; the last decision does and lists it', async () => {
    const { pm, wakes, request } = makeBatch()
    const a = await request('x_alpha', 'tc_a')
    const b = await request('x_beta', 'tc_b')
    const c = await request('x_gamma', 'tc_c')

    await pm.handleResponse(a, true, async () => {})
    await pm.expirePermission('msg_tc_b', b, CHANNEL)
    await tick()
    expect(wakes).toHaveLength(0)

    await pm.handleResponse(c, false)
    await tick()
    expect(wakes).toHaveLength(1)
    expect(wakes[0].outcomes).toEqual([
      { toolName: 'x_alpha', outcome: 'granted' },
      { toolName: 'x_beta', outcome: 'expired' },
      { toolName: 'x_gamma', outcome: 'denied' },
    ])
  })

  it('[PERMB-AC-3] after a wake the next batch starts empty', async () => {
    const { pm, wakes, request } = makeBatch()
    const a = await request('x_alpha', 'tc_a')
    await pm.handleResponse(a, false)
    await tick()
    const b = await request('x_beta', 'tc_b')
    await pm.handleResponse(b, false)
    await tick()
    expect(wakes).toHaveLength(2)
    expect(wakes[1].outcomes).toEqual([{ toolName: 'x_beta', outcome: 'denied' }])
  })
})

describe('buildPermissionBatchWakeText (PERMB-REQ-3)', () => {
  it('[PERMB-AC-3] names approved and denied tools, omitting empty sections', () => {
    const text = buildPermissionBatchWakeText([
      { toolName: 'a', outcome: 'granted' },
      { toolName: 'b', outcome: 'granted' },
      { toolName: 'c', outcome: 'denied' },
    ])
    expect(text).toStartWith('[Permission] The user decided on the pending tool calls of your last turn.')
    expect(text).toContain("Approved and executed: 'a', 'b' — their results are in the tool history above.")
    expect(text).toContain("Denied: 'c' — do not retry it; continue conversationally")
    expect(text).not.toContain('expired')
    expect(text).not.toContain('not executed')
  })

  it('[PERMB-AC-3] lists expired requests as not answered', () => {
    const text = buildPermissionBatchWakeText([
      { toolName: 'a', outcome: 'denied' },
      { toolName: 'b', outcome: 'expired' },
    ])
    expect(text).toContain("Not answered (expired): 'b'.")
    expect(text).not.toContain('Approved')
  })
})

// ---------------------------------------------------------------------------
// MessageHandler side
// ---------------------------------------------------------------------------

function makeSessionStore(parts: any[]) {
  const written: any[] = []
  return {
    written,
    store: {
      getMessagesForLLM: async () => ({
        summary: undefined,
        messages: [{ info: { id: 'msg_turn_1', role: 'assistant' }, parts }],
      }),
      writePart: async (part: any) => {
        written.push(part)
      },
    },
  }
}

function markerPart(id: string, callID: string, tool: string) {
  return {
    id,
    sessionID: CHANNEL,
    messageID: 'msg_turn_1',
    type: 'tool',
    tool,
    callID,
    state: {
      status: 'completed',
      input: {},
      output: JSON.stringify({ status: 'permission_requested', tool }),
      title: '',
      metadata: {},
      time: { start: 1000, end: 2000 },
    },
  }
}

describe('MessageHandler — grant and deny rewrite the history, never wake (PERMB-REQ-3)', () => {
  it('[PERMB-AC-3] executeRestoredTool runs the tool, rewrites its session part and does NOT wake', async () => {
    const { store, written } = makeSessionStore([markerPart('part_a', 'tc_a', 'x_alpha')])
    const processAgentResponse = mock(async () => {})
    const executeTool = mock(async () => ({ output: '{"ok":true}', isError: false }))
    const stub: any = {
      channelManager: {
        getChannel: async () => ({ agentId: 'agent_1', workspaceId: 'work_1', userId: undefined }),
      },
      getToolExecutor: async () => ({ getAppIdForTool: () => 'app_x' }),
      db: { collection: () => ({ updateOne: async () => ({}), findOne: async () => null }) },
      broadcastToChannel: () => {},
      mcaManager: { executeTool },
      sessionStore: store,
      processAgentResponse,
      updateSessionToolPartResult: (MessageHandler.prototype as any).updateSessionToolPartResult,
    }

    await (MessageHandler.prototype as any).executeRestoredTool.call(
      stub,
      CHANNEL,
      'msg_tc_a',
      'tc_a',
      'x_alpha',
      { q: 1 },
      'app_x',
      'work_1',
    )

    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(written).toHaveLength(1)
    expect(written[0].state.output).toBe('{"ok":true}')
    expect(processAgentResponse).not.toHaveBeenCalled()
  })

  it('[PERMB-AC-3] the deny rewrite turns the marker part into an error result with the denial', async () => {
    const { store, written } = makeSessionStore([
      markerPart('part_a', 'tc_a', 'x_alpha'),
      markerPart('part_b', 'tc_b', 'x_beta'),
    ])
    await (MessageHandler.prototype as any).updateSessionToolPartResult.call(
      { sessionStore: store },
      CHANNEL,
      'tc_b',
      'x_beta',
      { output: "Permission denied: User declined to allow execution of 'x_beta'.", isError: true },
      0,
    )
    expect(written).toHaveLength(1)
    expect(written[0].callID).toBe('tc_b')
    expect(written[0].state.status).toBe('error')
    expect(written[0].state.error).toBe("Permission denied: User declined to allow execution of 'x_beta'.")
  })

  it('[PERMB-AC-3] "Allow always" resolving both pendings of the tool wakes once', async () => {
    const { pm, wakes, request } = makeBatch()
    await request('x_alpha', 'tc_1')
    await request('x_alpha', 'tc_2')
    const restored: any[] = []
    const stub: any = {
      permissionManager: pm,
      eventHandler: undefined,
      executeRestoredTool: async (...args: any[]) => {
        restored.push(args)
      },
      handlePermissionResponse: (MessageHandler.prototype as any).handlePermissionResponse,
    }

    const resolved = await (MessageHandler.prototype as any).applyToolPermissionToPendingRequests.call(
      stub,
      'app_x',
      'x_alpha',
      'allow',
    )
    await tick()

    expect(resolved).toBe(2)
    expect(restored).toHaveLength(2)
    expect(wakes).toHaveLength(1)
    expect(wakes[0].outcomes).toEqual([
      { toolName: 'x_alpha', outcome: 'granted' },
      { toolName: 'x_alpha', outcome: 'granted' },
    ])
  })
})
