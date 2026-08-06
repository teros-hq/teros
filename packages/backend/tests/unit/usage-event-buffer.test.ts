import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_BUFFER_OPTS,
  UsageEventBuffer,
} from '../../src/services/usage-event-buffer'
import type { AgentUsageEvent } from '../../src/types/database'

function makeEvent(eventId: string): AgentUsageEvent {
  return {
    eventId,
    sessionUsageId: 'usess_1',
    type: 'session.started',
    payload: {
      parentSessionUsageId: null,
      triggerKind: 'user_message',
      userId: 'user_1',
      agentId: 'agent_1',
      workspaceId: 'work_1',
      channelId: 'ch_1',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      startedAt: new Date(),
    },
    appliedAt: new Date(),
    schemaVersion: 1,
  }
}

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => stubLogger,
} as any

describe('UsageEventBuffer', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'usage-buffer-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('flushes events through the repo + applier on demand', async () => {
    const inserted: AgentUsageEvent[][] = []
    const applied: AgentUsageEvent[][] = []
    const repo = { bulkInsert: mock(async (e: AgentUsageEvent[]) => (inserted.push(e), e.length)) }
    const applier = { applyBatch: mock(async (e: AgentUsageEvent[]) => (applied.push(e), e.length)) }
    const buffer = new UsageEventBuffer(repo as any, applier as any, stubLogger, {
      ...DEFAULT_BUFFER_OPTS,
      deadLetterDir: dir,
    })

    buffer.emit(makeEvent('e1'))
    buffer.emit(makeEvent('e2'))
    await buffer.flush()

    expect(inserted.flat().length).toBe(2)
    expect(applied.flat().length).toBe(2)
  })

  it('writes a dead-letter file when the repo fails after retries', async () => {
    const repo = {
      bulkInsert: mock(async () => {
        throw new Error('mongo down')
      }),
    }
    const applier = { applyBatch: mock(async () => 0) }
    const buffer = new UsageEventBuffer(repo as any, applier as any, stubLogger, {
      ...DEFAULT_BUFFER_OPTS,
      deadLetterDir: dir,
      retryMaxAttempts: 2,
      retryBaseDelayMs: 1,
    })

    buffer.emit(makeEvent('e1'))
    await buffer.flush()

    const files = await readdir(dir)
    expect(files.some((f) => f.startsWith('usage-events-dead-letter-'))).toBe(true)
  })

  it('uses a single flush attempt during shutdown then dead-letters (A1.9)', async () => {
    // With Mongo down, the 3-retry backoff would blow PM2's kill_timeout; during
    // shutdown the buffer must try once then fall straight to the dead-letter.
    let attempts = 0
    const repo = {
      bulkInsert: mock(async () => {
        attempts++
        throw new Error('mongo down')
      }),
    }
    const applier = { applyBatch: mock(async () => 0) }
    const buffer = new UsageEventBuffer(repo as any, applier as any, stubLogger, {
      ...DEFAULT_BUFFER_OPTS,
      deadLetterDir: dir,
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1,
    })

    buffer.emit(makeEvent('e1'))
    await buffer.shutdown({ timeoutMs: 1000 })

    expect(attempts).toBe(1) // mutation: `this.shuttingDown ? 1 : …` → 3 breaks this
    const files = await readdir(dir)
    expect(files.some((f) => f.startsWith('usage-events-dead-letter-'))).toBe(true)
  })

  it('shutdown budget returns instead of hanging when Mongo never responds (A1.9)', async () => {
    // bulkInsert never resolves (server-selection stuck). Without the Promise.race
    // budget, shutdown would hang forever and PM2 would SIGKILL past kill_timeout.
    const repo = { bulkInsert: mock(() => new Promise<number>(() => {})) }
    const applier = { applyBatch: mock(async () => 0) }
    const buffer = new UsageEventBuffer(repo as any, applier as any, stubLogger, {
      ...DEFAULT_BUFFER_OPTS,
      deadLetterDir: dir,
    })

    buffer.emit(makeEvent('e1'))
    const t0 = performance.now()
    await buffer.shutdown({ timeoutMs: 50 })
    const elapsed = performance.now() - t0

    expect(elapsed).toBeLessThan(1000) // budget cut it; a bare `await flush()` would hang
  })

  it('counts dropped events when the queue is saturated and the event is non-critical', async () => {
    const repo = { bulkInsert: mock(async () => 0) }
    const applier = { applyBatch: mock(async () => 0) }
    const buffer = new UsageEventBuffer(repo as any, applier as any, stubLogger, {
      ...DEFAULT_BUFFER_OPTS,
      deadLetterDir: dir,
      maxQueueDepth: 1,
    })

    buffer.emit({ ...makeEvent('e1'), type: 'session.delta', payload: {} as any })
    // Second non-critical event must be dropped (queue depth == maxQueueDepth)
    buffer.emit({ ...makeEvent('e2'), type: 'session.delta', payload: {} as any })

    const metrics = await buffer.getMetrics()
    expect(metrics.events_dropped).toBeGreaterThanOrEqual(1)
  })

  it('exposes counters via getMetrics()', async () => {
    const repo = { bulkInsert: mock(async (e: AgentUsageEvent[]) => e.length) }
    const applier = { applyBatch: mock(async (e: AgentUsageEvent[]) => e.length) }
    const buffer = new UsageEventBuffer(repo as any, applier as any, stubLogger, {
      ...DEFAULT_BUFFER_OPTS,
      deadLetterDir: dir,
    })
    buffer.emit(makeEvent('m1'))
    await buffer.flush()
    const metrics = await buffer.getMetrics()
    expect(metrics.events_enqueued).toBe(1)
    expect(metrics.events_flushed).toBe(1)
    expect(metrics.queue_depth).toBe(0)
  })

  it('drops events emitted after shutdown() (N2 fix)', async () => {
    const repo = { bulkInsert: mock(async (e: AgentUsageEvent[]) => e.length) }
    const applier = { applyBatch: mock(async (e: AgentUsageEvent[]) => e.length) }
    const buffer = new UsageEventBuffer(repo as any, applier as any, stubLogger, {
      ...DEFAULT_BUFFER_OPTS,
      deadLetterDir: dir,
    })
    await buffer.shutdown()
    buffer.emit(makeEvent('post-shutdown'))
    const metrics = await buffer.getMetrics()
    expect(metrics.events_enqueued).toBe(0)
    expect(metrics.events_dropped).toBe(1)
    expect(metrics.queue_depth).toBe(0)
  })

  it('writes critical session.started directly to Mongo when queue is saturated (M2)', async () => {
    const inserted: AgentUsageEvent[][] = []
    const applied: AgentUsageEvent[][] = []
    const repo = {
      bulkInsert: mock(async (e: AgentUsageEvent[]) => {
        inserted.push(e)
        return e.length
      }),
    }
    const applier = {
      applyBatch: mock(async (e: AgentUsageEvent[]) => {
        applied.push(e)
        return e.length
      }),
    }
    const buffer = new UsageEventBuffer(repo as any, applier as any, stubLogger, {
      ...DEFAULT_BUFFER_OPTS,
      deadLetterDir: dir,
      maxQueueDepth: 1,
    })

    // fill the queue with a non-critical event so depth == 1 → saturated
    buffer.emit({ ...makeEvent('e1'), type: 'session.delta', payload: {} as any })
    // critical session.started must NOT go to the queue
    buffer.emit(makeEvent('critical'))
    // give the fire-and-forget direct write a tick to complete
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(inserted).toHaveLength(1)
    expect(inserted[0][0].eventId).toBe('critical')
    expect(applied).toHaveLength(1)
  })

  it('falls back to dead-letter file when critical direct write fails (M2)', async () => {
    const repo = {
      bulkInsert: mock(async () => {
        throw new Error('mongo down')
      }),
    }
    const applier = { applyBatch: mock(async () => 0) }
    const buffer = new UsageEventBuffer(repo as any, applier as any, stubLogger, {
      ...DEFAULT_BUFFER_OPTS,
      deadLetterDir: dir,
      maxQueueDepth: 1,
    })

    buffer.emit({ ...makeEvent('e1'), type: 'session.delta', payload: {} as any })
    buffer.emit(makeEvent('critical'))
    // wait for the async fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 20))

    const files = await readdir(dir)
    expect(files.some((f) => f.startsWith('usage-events-dead-letter-'))).toBe(true)
  })
})
