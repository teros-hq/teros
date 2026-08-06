/**
 * PendingFormsRegistry — in-memory state of the inline-form flow
 *.
 *
 * Deliberately a sibling of PendingApprovalsRegistry rather than a
 * generalization of it: the permission registry is security-sensitive
 * (fail-closed invariants) and its resolution is a boolean, while a form
 * resolves to an arbitrary payload. Sharing an abstraction would couple the
 * two lifecycles for little gain.
 *
 * Lifecycle invariants:
 *   - `delete(rid)` cleans BOTH the pending Map AND the channel index.
 *   - `recordResolved(rid)` marks the request idempotent for 5min; duplicate
 *     handleResponse calls return without side effects.
 *   - `clear()` resets everything (process shutdown / test teardown).
 */

import type { FormSpec, FormValues } from '@teros/shared'

/** How a pending form got resolved. */
export type FormResolution =
  | { kind: 'submitted'; values: FormValues; notes?: string }
  | { kind: 'dismissed' }
  /** The form could never be shown (no UI anchor, channel teardown, another
   * form already pending). `reason` is surfaced to the agent so it can fall
   * back to asking conversationally — distinct from 'dismissed', which means
   * the user SAW the form and declined it. */
  | { kind: 'unavailable'; reason: string }

/** In-memory record of a pending form request. */
export interface PendingForm {
  resolve: (resolution: FormResolution) => void
  reject: (error: Error) => void
  spec: FormSpec
  channelId: string
  messageId?: string
  toolCallId?: string
  /** Restored after a backend restart — the original turn is gone. */
  restored?: boolean
  userId?: string
  createdAt?: number
}

interface ResolvedRecord {
  at: number
  resolution: FormResolution
}

const DEFAULT_RESOLVED_TTL_MS = 5 * 60 * 1000
const DEFAULT_RESOLVED_PRUNE_THRESHOLD = 256

export interface PendingFormsRegistryOpts {
  resolvedTtlMs?: number
  resolvedPruneThreshold?: number
}

export class PendingFormsRegistry {
  private readonly pending = new Map<string, PendingForm>()
  private readonly resolved = new Map<string, ResolvedRecord>()
  private readonly resolvedTtlMs: number
  private readonly resolvedPruneThreshold: number

  constructor(opts: PendingFormsRegistryOpts = {}) {
    this.resolvedTtlMs = opts.resolvedTtlMs ?? DEFAULT_RESOLVED_TTL_MS
    this.resolvedPruneThreshold = opts.resolvedPruneThreshold ?? DEFAULT_RESOLVED_PRUNE_THRESHOLD
  }

  register(requestId: string, form: PendingForm): void {
    this.pending.set(requestId, form)
  }

  get(requestId: string): PendingForm | undefined {
    return this.pending.get(requestId)
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  delete(requestId: string): boolean {
    return this.pending.delete(requestId)
  }

  size(): number {
    return this.pending.size
  }

  entries(): IterableIterator<[string, PendingForm]> {
    return this.pending.entries()
  }

  /** One live form per channel (v1 rule): a second request-user-input while
   * one is pending gets a tool error. */
  hasPendingInChannel(channelId: string): boolean {
    for (const form of this.pending.values()) {
      if (form.channelId === channelId) return true
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Idempotency (resolved TTL)
  // ---------------------------------------------------------------------------

  recordResolved(requestId: string, resolution: FormResolution): void {
    this.resolved.set(requestId, { at: Date.now(), resolution })
    if (this.resolved.size > this.resolvedPruneThreshold) {
      this.pruneResolved()
    }
  }

  getResolved(requestId: string): ResolvedRecord | undefined {
    return this.resolved.get(requestId)
  }

  pruneResolved(now: number = Date.now()): number {
    const cutoff = now - this.resolvedTtlMs
    let pruned = 0
    for (const [k, v] of this.resolved) {
      if (v.at < cutoff) {
        this.resolved.delete(k)
        pruned++
      }
    }
    return pruned
  }

  clear(): void {
    this.pending.clear()
    this.resolved.clear()
  }
}
