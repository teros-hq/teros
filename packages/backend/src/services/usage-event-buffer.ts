/**
 * In-memory buffer for agent usage events.
 *
 * Flow:
 *   emit() → queue
 *   flush() → bulkInsert agent_usage_events → applier.applyBatch
 *
 * Properties:
 *   - Singleton per process.
 *   - `session.started` is flushed synchronously if queue is saturated (we
 *     can never lose the first event of a session).
 *   - Retry with exponential backoff (500/1000/2000 ms by default) on flush
 *     failure. After all retries: append to dead-letter file (rotated
 *     in-process by size or age, see DEAD_LETTER_*).
 *   - Try/catch hard around every public method. A buffer failure must NEVER
 *     propagate to the agent.
 *   - Metrics exposed via getMetrics() for `/metrics` Prometheus endpoint.
 *   - shutdown() flushes pending events on SIGTERM.
 *
 *
 */

import { resolve } from "node:path"
import type { Logger } from "pino"
import { withRetry } from "../lib/with-retry.js"
import type { AgentUsageEvent } from "../types/database.js"
import type { AgentUsageEventApplier } from "./agent-usage-event-applier.js"
import type { AgentUsageEventRepository } from "./agent-usage-event-repository.js"
import { BufferMetrics } from "./buffer-metrics.js"
import { DeadLetterFileWriter } from "./dead-letter-file-writer.js"

export interface UsageEventBufferOptions {
  /** Flush when queue reaches this size. */
  maxBatchSize: number
  /** Flush at most every N ms. */
  flushIntervalMs: number
  /** Drop non-critical events when queue depth exceeds this. */
  maxQueueDepth: number
  /** Retry attempts before sending to dead-letter. */
  retryMaxAttempts: number
  /** Base delay for exponential backoff (doubles each attempt). */
  retryBaseDelayMs: number
  /** Directory for dead-letter NDJSON files. */
  deadLetterDir: string
  /** Rotate dead-letter file after N MB. */
  deadLetterMaxFileMb: number
  /** Rotate dead-letter file after N hours. */
  deadLetterMaxFileHours: number
}

export const DEFAULT_BUFFER_OPTS: UsageEventBufferOptions = {
  maxBatchSize: 100,
  flushIntervalMs: 1000,
  maxQueueDepth: 10_000,
  retryMaxAttempts: 3,
  retryBaseDelayMs: 500,
  deadLetterDir: resolve(process.cwd(), "logs"),
  deadLetterMaxFileMb: 100,
  deadLetterMaxFileHours: 24,
}

export interface UsageEventBufferMetrics {
  events_enqueued: number
  events_flushed: number
  events_dropped: number
  events_retried: number
  flush_errors: number
  flush_latency_ms_p50: number
  flush_latency_ms_p95: number
  queue_depth: number
  queue_depth_high_water: number
  dead_letter_total_size_bytes: number
}

export class UsageEventBuffer {
  private queue: AgentUsageEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private flushing = false
  private shuttingDown = false
  private readonly deadLetter: DeadLetterFileWriter
  private readonly metrics: BufferMetrics

  constructor(
    private readonly repo: AgentUsageEventRepository,
    private readonly applier: AgentUsageEventApplier,
    private readonly log: Logger,
    public readonly opts: UsageEventBufferOptions = DEFAULT_BUFFER_OPTS,
    deadLetter?: DeadLetterFileWriter,
    metrics?: BufferMetrics,
  ) {
    this.deadLetter =
      deadLetter ??
      new DeadLetterFileWriter({
        dir: opts.deadLetterDir,
        maxFileMb: opts.deadLetterMaxFileMb,
        maxFileHours: opts.deadLetterMaxFileHours,
      })
    this.metrics = metrics ?? new BufferMetrics()
  }

  /**
   * Start the periodic flush timer. Idempotent.
   */
  start(): void {
    if (this.flushTimer !== null) return
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        this.log.error({ err }, "usage-event-buffer: periodic flush failed")
      })
    }, this.opts.flushIntervalMs)
    // Don't keep the event loop alive just for this timer.
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref()
  }

  /**
   * Enqueue an event. Never throws.
   *
   * Post-shutdown: events are dropped (counted) — the timer is gone and the
   * Mongo client may already be closed.
   *
   * Saturated queue: `session.started` bypasses the queue and is written
   * directly to Mongo (or, on failure, directly to the dead-letter file).
   * This guarantees that the session origin is preserved in *some* durable
   * sink. Other event types are dropped and counted.
   */
  emit(event: AgentUsageEvent): void {
    try {
      if (this.shuttingDown) {
        this.metrics.incrementDropped()
        this.log.warn(
          { eventType: event.type },
          "usage-event-buffer: drop after shutdown",
        )
        return
      }
      this.metrics.incrementEnqueued()

      if (this.queue.length >= this.opts.maxQueueDepth) {
        // `session.started` AND `session.running` are the two lifecycle
        // transitions we can never lose: dropping `running` would leave the
        // session `queued`, and the applier's `{status:'running'}` guard would
        // then drop the turn's `session.delta` (lost tokens → silent
        // under-billing). Bypass the queue for both (TER-650/G1).
        if (event.type === "session.started" || event.type === "session.running") {
          // Critical path: bypass the queue and write directly. The await
          // chain starts immediately and is detached from the saturated
          // queue's flush schedule. Guarantees: the event ends up in Mongo
          // OR in the dead-letter file before this fire-and-forget Promise
          // settles. emit() itself stays void/non-throwing for callers.
          this.writeCriticalEventDirectly(event).catch((err) => {
            this.log.error(
              { err, eventType: event.type },
              "usage-event-buffer: critical direct write failed",
            )
          })
        } else {
          this.metrics.incrementDropped()
          this.log.warn(
            { eventType: event.type, queueDepth: this.queue.length },
            "usage-event-buffer: drop (queue saturated)",
          )
        }
        return
      }

      this.queue.push(event)
      this.metrics.recordQueueDepth(this.queue.length)

      if (this.queue.length >= this.opts.maxBatchSize) {
        // Don't await; fire-and-forget.
        this.flush().catch(() => {
          /* logged inside flush */
        })
      }
    } catch (err) {
      // A failure of the instrumentation must NEVER propagate to the caller.
      this.log.error({ err }, "usage-event-buffer: emit failed silently")
    }
  }

  /**
   * Drain the queue to Mongo. Idempotent and safe to call concurrently
   * (only one flush runs at a time; concurrent callers return immediately).
   */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return
    this.flushing = true

    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.opts.maxBatchSize)
        await this.flushBatchWithRetry(batch)
      }
    } finally {
      this.flushing = false
    }
  }

  /**
   * Flush pending events on SIGTERM. After this returns, no more events are
   * accepted (queue ignored on emit; we only log).
   */
  async shutdown(opts?: { timeoutMs?: number }): Promise<void> {
    this.shuttingDown = true
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    const flushDone = this.flush().catch((err) => {
      this.log.error({ err }, "usage-event-buffer: shutdown flush failed")
    })

    // Unbounded (default): wait for the flush to finish. Bounded: race the flush
    // against a budget, and if the budget wins (Mongo unreachable), dump whatever
    // is still queued straight to the dead-letter so we honour the "Mongo OR
    // dead-letter" guarantee before PM2 SIGKILLs us past kill_timeout (A1.9).
    const timeoutMs = opts?.timeoutMs
    if (timeoutMs == null) {
      await flushDone
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<"timeout">((res) => {
      timer = setTimeout(() => res("timeout"), timeoutMs)
    })
    const winner = await Promise.race([flushDone.then(() => "flushed" as const), budget])
    if (timer) clearTimeout(timer)

    if (winner === "timeout") {
      const remaining = this.queue.splice(0)
      if (remaining.length > 0) {
        this.log.warn(
          { remaining: remaining.length },
          "usage-event-buffer: shutdown budget exceeded → draining queue to dead-letter",
        )
        await this.writeDeadLetter(remaining).catch((err) => {
          this.log.error({ err }, "usage-event-buffer: shutdown dead-letter drain failed")
        })
      }
    }
  }

  /**
   * Snapshot of current metrics. Read by /metrics and by the health endpoint.
   */
  async getMetrics(): Promise<UsageEventBufferMetrics> {
    const deadLetterSize = await this.deadLetter.totalSizeBytes()
    return this.metrics.snapshot(this.queue.length, deadLetterSize)
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async flushBatchWithRetry(batch: AgentUsageEvent[]): Promise<void> {
    const t0 = performance.now()
    const result = await withRetry(
      async () => {
        await this.repo.bulkInsert(batch)
        await this.applier.applyBatch(batch)
      },
      {
        // During shutdown, a single attempt then dead-letter — the 3-retry
        // backoff would blow the PM2 kill_timeout with Mongo down (A1.9).
        maxAttempts: this.shuttingDown ? 1 : this.opts.retryMaxAttempts,
        baseDelayMs: this.opts.retryBaseDelayMs,
        onAttemptFail: (err, attempt) => {
          this.metrics.incrementRetried()
          this.log.warn(
            { err, attempt, batchSize: batch.length },
            "usage-event-buffer: flush attempt failed",
          )
        },
      },
    )

    if (result.ok) {
      this.metrics.recordFlushLatencyMs(performance.now() - t0)
      this.metrics.incrementFlushed(batch.length)
      return
    }

    // All retries exhausted → dead-letter
    this.metrics.incrementFlushErrors()
    this.log.error(
      { err: result.lastError, batchSize: batch.length },
      "usage-event-buffer: flush exhausted retries → dead-letter",
    )
    await this.writeDeadLetter(batch).catch((err) => {
      this.log.error({ err }, "usage-event-buffer: dead-letter write failed")
    })
  }

  /**
   * Bypass the queue and write a critical event directly to Mongo. On any
   * failure (including Mongo unavailable), write it directly to the
   * dead-letter file so the event survives in *some* durable sink. The
   * caller fires this without awaiting; the work starts immediately.
   *
   * Guarantee: by the time the returned Promise settles, the event is in
   * agent_usage_events (and projected) OR in the dead-letter file on disk.
   */
  private async writeCriticalEventDirectly(event: AgentUsageEvent): Promise<void> {
    try {
      await this.repo.bulkInsert([event])
      await this.applier.applyBatch([event])
      this.metrics.incrementFlushed(1)
    } catch (err) {
      this.log.error(
        { err, eventType: event.type },
        "usage-event-buffer: critical event Mongo write failed; falling back to dead-letter",
      )
      await this.writeDeadLetter([event])
    }
  }

  private async writeDeadLetter(batch: AgentUsageEvent[]): Promise<void> {
    await this.deadLetter.write(batch)
  }
}

