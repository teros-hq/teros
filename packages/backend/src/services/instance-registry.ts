/**
 * Instance registry — "is any other backend instance alive right now?"
 *
 * During a blue/green handoff (DEP-REQ-3) two backend processes share the
 * database for up to a minute. Every periodic job is already leader-gated,
 * but the boot-time resume sweep (ResumeService) is not a periodic job: it
 * runs once, a few seconds after boot, and resumes every channel it finds
 * with `running: true`. With the previous color still serving, that would
 * wake agents on conversations the other process is in the middle of
 * running — a duplicated turn per live conversation, on every deploy.
 *
 * So each instance registers its liveness as a leader lock named
 * `instance:<instanceId>` (TTL 15 s, refreshed every 5 s) and releases it at
 * the very end of graceful shutdown. The resume sweep waits until no other
 * instance is registered (DEP-REQ-6). A crashed instance disappears when
 * its lock expires — the same semantics every other lock already relies on,
 * and no new collection: `leader_locks` has the unique `name` index and the
 * TTL index on `expiresAt`.
 *
 * @spec DEP-REQ-6
 */
import type { LeaderElectionService } from './leader-election'

export const INSTANCE_LOCK_PREFIX = 'instance:'

/** Lock TTL: an instance that stops heartbeating is "gone" after this long. */
export const INSTANCE_TTL_MS = 15_000
/** Heartbeat period: well under the TTL so one missed beat does not expire us. */
export const INSTANCE_HEARTBEAT_MS = 5_000

export interface InstanceRegistryOptions {
  ttlMs?: number
  heartbeatMs?: number
  /** Injected clock for tests. */
  sleep?: (ms: number) => Promise<void>
  log?: Pick<Console, 'warn' | 'info'>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class InstanceRegistry {
  private readonly ttlMs: number
  private readonly heartbeatMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: Pick<Console, 'warn' | 'info'>
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(
    private readonly leader: LeaderElectionService,
    opts: InstanceRegistryOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? INSTANCE_TTL_MS
    this.heartbeatMs = opts.heartbeatMs ?? INSTANCE_HEARTBEAT_MS
    this.sleep = opts.sleep ?? defaultSleep
    this.log = opts.log ?? console
  }

  /** This instance's lock name. */
  get lockName(): string {
    return `${INSTANCE_LOCK_PREFIX}${this.leader.getOwnerId()}`
  }

  /**
   * Register now and keep the registration fresh. Idempotent. A failed
   * acquire or heartbeat is logged and retried on the next beat — liveness
   * must never take the backend down.
   */
  async start(): Promise<void> {
    this.stopped = false
    await this.beat()
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.beat()
    }, this.heartbeatMs)
    this.timer.unref?.()
  }

  /**
   * Deregister. Called at the END of graceful shutdown: as long as this
   * process may still be finishing work, other instances must see it alive.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    try {
      await this.leader.release(this.lockName)
    } catch (err) {
      this.log.warn('[instances] release failed (the lock expires on its own):', err)
    }
  }

  /** Ids of the other instances currently registered and not expired. */
  async othersAlive(): Promise<string[]> {
    const docs = await this.leader.listLiveOthers(INSTANCE_LOCK_PREFIX)
    return docs.map((d) => d.name.slice(INSTANCE_LOCK_PREFIX.length))
  }

  /**
   * Resolve when no other instance is registered. Polls every `pollMs`, at
   * most `timeoutMs`; returns false (after logging) when the wait timed out,
   * so the caller can proceed with a warning instead of never resuming.
   */
  async waitUntilSoleInstance(opts: { pollMs: number; timeoutMs: number }): Promise<boolean> {
    const deadline = Date.now() + opts.timeoutMs
    let announced = false
    for (;;) {
      const others = await this.othersAlive()
      if (others.length === 0) return true
      if (!announced) {
        this.log.info(`[instances] waiting for ${others.length} other instance(s) to go away: ${others.join(', ')}`)
        announced = true
      }
      if (Date.now() >= deadline) {
        this.log.warn(`[instances] still seeing ${others.join(', ')} after ${opts.timeoutMs}ms — proceeding anyway`)
        return false
      }
      await this.sleep(opts.pollMs)
    }
  }

  private async beat(): Promise<void> {
    if (this.stopped) return
    try {
      const ok = await this.leader.tryAcquire(this.lockName, this.ttlMs)
      if (!ok) this.log.warn(`[instances] could not refresh ${this.lockName}`)
    } catch (err) {
      this.log.warn('[instances] heartbeat failed:', err)
    }
  }
}
