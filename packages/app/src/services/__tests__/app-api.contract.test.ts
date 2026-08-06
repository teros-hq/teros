/**
 * AppApi — contract / boundary tests.
 *
 * AppApi is a thin typed wrapper over Transport.request(action, payload, options).
 * The contract that matters is the EXACT action, payload and options each method
 * emits. This suite focuses on testMcaTool, whose options carry a load-bearing
 * timeout override: the admin live-test path runs the same backend call as a
 * normal tool call (mcaManager.executeTool), which cold-starts the MCA container
 * when it is on standby. The backend's container health-wait budget is up to 90s
 * (MCA_HEALTH_TIMEOUT_MS — a source-mounted cold start does a node_modules copy +
 * npm install + tsx compile before its HTTP server binds), plus the SDK WS-connect
 * wait and real tool execution on top. The default 10s WS request timeout is far
 * shorter than that, so a bare request threw "WsTransport: request timeout —
 * app.test-mca-tool" on every cold-container test. testMcaTool must therefore emit
 * an explicit timeout ABOVE the backend spawn budget. This test fails on the old
 * code (options: undefined / inherited 10s default) and passes once the override
 * is present.
 *
 * Runner: bun:test (pure logic, node-env).
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { AppApi } from '../AppApi'
import { CapturingTransport } from './_helpers'

describe('AppApi — request payload contract', () => {
  let transport: CapturingTransport
  let api: AppApi

  beforeEach(() => {
    transport = new CapturingTransport()
    api = new AppApi(transport)
  })

  it('testMcaTool sends the mcaId + tool and overrides the timeout above the backend spawn budget', () => {
    api.testMcaTool('mca_notion', 'search')
    const call = transport.last()
    expect(call.action).toBe('app.test-mca-tool')
    expect(call.payload).toEqual({ mcaId: 'mca_notion', tool: 'search' })
    // Load-bearing: the timeout MUST exceed the backend cold-start budget (up to
    // 90s health-wait + WS-connect). The inherited 10s default caused the reported
    // "WsTransport: request timeout — app.test-mca-tool".
    expect(call.options?.timeout).toBeDefined()
    expect(call.options!.timeout!).toBeGreaterThan(90_000)
  })

  it('testMcaTool includes input only when provided, keeping the timeout override', () => {
    api.testMcaTool('mca_notion', 'search', { query: 'teros' })
    expect(transport.last()).toEqual({
      action: 'app.test-mca-tool',
      payload: { mcaId: 'mca_notion', tool: 'search', input: { query: 'teros' } },
      options: { timeout: 120_000 },
    })
  })

  it('testMcaTool omits input when absent (boundary)', () => {
    api.testMcaTool('mca_notion', 'search')
    expect(transport.last().payload).toEqual({ mcaId: 'mca_notion', tool: 'search' })
  })
})
