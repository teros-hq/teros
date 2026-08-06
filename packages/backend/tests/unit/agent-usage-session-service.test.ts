import { describe, expect, it } from 'bun:test'
import {
  AgentUsageSessionService,
  classifyError,
} from '../../src/services/agent-usage-session-service'

describe('AgentUsageSessionService.start — actualProvider/actualModel seeding (TER-616/C1)', () => {
  function makeService() {
    const emitted: any[] = []
    const buffer = { emit: (e: any) => emitted.push(e) } as any
    return { svc: new AgentUsageSessionService(buffer), emitted }
  }

  const base = {
    parentSessionUsageId: null,
    triggerKind: 'user_message' as const,
    userId: 'user_1',
    agentId: 'agent_1',
    workspaceId: 'work_1',
    channelId: 'ch_1',
    provider: 'teros' as any,
    modelId: 'teros-kimi-k2.6',
  }

  it('emits actualProvider/actualModel in the session.started payload when provided', () => {
    const { svc, emitted } = makeService()
    svc.start({
      ...base,
      actualProvider: 'fireworks',
      actualModel: 'accounts/fireworks/models/kimi-k2p6',
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0].type).toBe('session.started')
    // Mutation: dropping the conditional spread (pre-R1) → undefined → red.
    expect(emitted[0].payload.actualProvider).toBe('fireworks')
    expect(emitted[0].payload.actualModel).toBe('accounts/fireworks/models/kimi-k2p6')
  })

  it('omits the keys entirely when not provided (no phantom undefined for non-split providers)', () => {
    const { svc, emitted } = makeService()
    svc.start({ ...base, provider: 'anthropic' as any, modelId: 'claude-sonnet-4-5' })
    expect('actualProvider' in emitted[0].payload).toBe(false)
    expect('actualModel' in emitted[0].payload).toBe(false)
  })
})

describe('AgentUsageSessionService — queued→running lifecycle (TER-650/G1)', () => {
  function makeService() {
    const emitted: any[] = []
    const buffer = { emit: (e: any) => emitted.push(e) } as any
    return { svc: new AgentUsageSessionService(buffer), emitted }
  }
  const base = {
    parentSessionUsageId: null,
    triggerKind: 'user_message' as const,
    userId: 'user_1',
    agentId: 'agent_1',
    workspaceId: 'work_1',
    channelId: 'ch_1',
    provider: 'anthropic' as any,
    modelId: 'claude-sonnet-4-5',
  }

  it('start() opens the session with NO execution anchor (queued)', () => {
    const { svc } = makeService()
    const handle = svc.start(base)
    // The handle has no execMonoStart until markRunning fires — the session is
    // queued and does not meter execution yet.
    expect(handle.execMonoStart).toBeUndefined()
  })

  it('markRunning() emits session.running and records the execution anchor', () => {
    const { svc, emitted } = makeService()
    const handle = svc.start(base)
    svc.markRunning(handle)
    const running = emitted.find((e) => e.type === 'session.running')
    expect(running).toBeDefined()
    expect(running.sessionUsageId).toBe(handle.sessionUsageId)
    expect(running.payload.startedAt).toBeInstanceOf(Date)
    // The anchor is now set so end() measures execution, not queue wait.
    expect(typeof handle.execMonoStart).toBe('number')
  })

  it('end() measures EXECUTION time (from markRunning), not the queue wait', () => {
    const { svc, emitted } = makeService()
    const handle = svc.start(base)
    // Simulate a long queue wait: the session sat 10s before executing.
    handle.monoStart = performance.now() - 10_000
    svc.markRunning(handle) // execMonoStart = ~now
    svc.end({ handle, status: 'completed' })
    const ended = emitted.find((e) => e.type === 'session.ended')
    // durationMs is anchored at execMonoStart (~0ms of execution), NOT monoStart
    // (~10s of queue wait). Mutation: anchor end() on monoStart again → this
    // jumps to ~10_000 → red. This is the queue-wait-not-billed guarantee.
    expect(ended.payload.durationMs).toBeLessThan(1_000)
  })

  it('end() reports durationMs=0 for a session that ended without ever running', () => {
    const { svc, emitted } = makeService()
    const handle = svc.start(base) // never markRunning (cancelled while queued)
    svc.end({ handle, status: 'aborted' })
    const ended = emitted.find((e) => e.type === 'session.ended')
    expect(ended.payload.durationMs).toBe(0)
    expect(ended.payload.status).toBe('aborted')
  })

  it('end() normalizes a raw running/queued status to a terminal completed', () => {
    const { svc, emitted } = makeService()
    const handle = svc.start(base)
    svc.markRunning(handle)
    svc.end({ handle, status: 'running' })
    const ended = emitted.find((e) => e.type === 'session.ended')
    expect(ended.payload.status).toBe('completed')
  })

  it('end() emits errorSubReason + sanitized upstreamMessage on session.ended (TER-698)', () => {
    const { svc, emitted } = makeService()
    const handle = svc.start(base)
    svc.markRunning(handle)
    svc.end({
      handle,
      status: 'errored',
      errorKind: 'rate_limited',
      errorSubReason: 'provider_capacity',
      // A leaked provider key in the literal must be scrubbed by the PII gate.
      upstreamMessage: '429 rate limit exceeded for fw_ABCDEFGHIJKLMNOPQRST12345',
    })
    const ended = emitted.find((e) => e.type === 'session.ended')
    expect(ended.payload.errorSubReason).toBe('provider_capacity')
    expect(ended.payload.upstreamMessage).toContain('rate limit exceeded')
    // Reuses sanitizeErrorMessage → the fw_ secret is redacted, never persisted.
    expect(ended.payload.upstreamMessage).not.toContain('fw_ABCDEFGHIJKLMNOPQRST12345')
    expect(ended.payload.upstreamMessage).toContain('[REDACTED_APIKEY]')
  })

  it('end() omits errorSubReason/upstreamMessage on a clean completion', () => {
    const { svc, emitted } = makeService()
    const handle = svc.start(base)
    svc.markRunning(handle)
    svc.end({ handle, status: 'completed' })
    const ended = emitted.find((e) => e.type === 'session.ended')
    expect('errorSubReason' in ended.payload).toBe(false)
    expect('upstreamMessage' in ended.payload).toBe(false)
  })
})

describe('classifyError', () => {
  it('returns "unknown" for non-objects', () => {
    expect(classifyError(undefined)).toBe('unknown')
    expect(classifyError(null)).toBe('unknown')
    expect(classifyError('boom')).toBe('unknown')
    expect(classifyError(42)).toBe('unknown')
  })

  it('maps interrupt / abort messages to aborted_by_user', () => {
    expect(classifyError({ type: 'aborted_by_user' })).toBe('aborted_by_user')
    expect(classifyError({ message: 'Processing interrupted by new message' })).toBe(
      'aborted_by_user',
    )
  })

  it('maps network/fetch keywords to network_error', () => {
    expect(classifyError({ name: 'NetworkError' })).toBe('network_error')
    expect(classifyError({ type: 'fetch_failed' })).toBe('network_error')
  })

  it('maps validation/invalid keywords to validation_error', () => {
    expect(classifyError({ type: 'validation_error' })).toBe('validation_error')
    expect(classifyError({ type: 'invalid_request' })).toBe('validation_error')
  })

  it('maps tool keywords to tool_error', () => {
    expect(classifyError({ type: 'tool_error' })).toBe('tool_error')
    expect(classifyError({ type: 'tool_timeout' })).toBe('tool_error')
  })

  it('maps llm/api keywords to llm_error', () => {
    expect(classifyError({ type: 'llm_error' })).toBe('llm_error')
    expect(classifyError({ type: 'api_error' })).toBe('llm_error')
  })

  it('maps session keyword to session_error', () => {
    expect(classifyError({ type: 'session_error' })).toBe('session_error')
  })

  it('falls back to unknown for unrecognized errors', () => {
    expect(classifyError({ type: 'foo' })).toBe('unknown')
  })

  it('maps the adapter errorClass buckets to their kinds (TER-615/TER-698)', () => {
    const cases: Array<[string, string]> = [
      ['rate_limited', 'rate_limited'],
      ['overloaded', 'overloaded'],
      ['server_error', 'server_error'],
      ['spend_gate', 'spend_gate'],
      ['auth', 'auth_error'],
      ['connection', 'network_error'],
      ['not_found', 'model_unavailable'],
    ]
    for (const [errorClass, kind] of cases) {
      expect(classifyError({ context: { errorClass } })).toBe(kind)
    }
  })

  it('404/not_found no longer telemeters as unknown (TER-698 gap fix)', () => {
    // Regression: before TER-698 `not_found` was absent from ERROR_CLASS_TO_KIND
    // and fell through to duck-typing → 'unknown'. It must map to model_unavailable.
    expect(classifyError({ context: { errorClass: 'not_found' } })).toBe('model_unavailable')
  })

  it('INVARIANT: every provider-limit errorClass maps to a non-unknown kind', () => {
    // Lint-as-test: wiring a new adapter errorClass here is mandatory — a bucket
    // that silently telemeters as `unknown` is invisible to the model-health
    // dashboard. This is exactly the class of gap TER-698 closed for `not_found`.
    const PROVIDER_LIMIT_CLASSES = [
      'rate_limited',
      'overloaded',
      'server_error',
      'spend_gate',
      'auth',
      'connection',
      'not_found',
    ]
    for (const errorClass of PROVIDER_LIMIT_CLASSES) {
      expect(classifyError({ context: { errorClass } })).not.toBe('unknown')
    }
  })
})
