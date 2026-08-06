/**
 * PendingApprovalsRegistry — TER-351.
 *
 * Encapsulates the in-memory state of the permission flow that previously lived
 * as scattered `Map` + `let` declarations inside `createPermissionManager`. A
 * dedicated class makes the contract explicit, the state instance-local, and
 * each piece testable in isolation.
 *
 * State tracked:
 *   1. Pending permissions   — Map<requestId, PendingPermission>.
 *   2. Resolved requests TTL — Map<requestId, ResolvedRecord> (idempotency).
 *   3. User-scoped index     — Map<userId, Set<requestId>> (navbar indicator).
 *
 * Lifecycle invariants (enforced by the API, not just by convention):
 *   - `register(rid, perm)` MUST set the user index when `perm.userId` is defined.
 *   - `delete(rid)` cleans BOTH the pending Map AND the user index.
 *   - `recordResolved(rid, resolution)` marks the request as idempotent for 5min;
 *     duplicate handleResponse calls return `isResolved=true` without side effects.
 *   - `clear()` resets everything (used at process shutdown / test teardown).
 */

/** Resolution type for a permission request. */
export type PermissionResolution = 'granted' | 'denied'

/** In-memory record of a pending permission request. */
export interface PendingPermission {
  resolve: (resolution: PermissionResolution) => void
  reject: (error: Error) => void
  toolName: string
  appId: string
  input: Record<string, any>
  channelId: string
  messageId?: string
  toolCallId?: string
  restored?: boolean
  userId?: string
  irreversible?: boolean
  createdAt?: number
}

/** Summary projection used by the navbar indicator broadcast. */
export interface PendingPermissionSummary {
  requestId: string
  toolName: string
  appId: string
  channelId: string
  messageId?: string
  toolCallId?: string
  irreversible?: boolean
  timestamp: number
}

interface ResolvedRecord {
  at: number
  resolution: PermissionResolution
}

const DEFAULT_RESOLVED_TTL_MS = 5 * 60 * 1000
const DEFAULT_RESOLVED_PRUNE_THRESHOLD = 256

/**
 * Kebab-normalised short tool name: strips the `<AppName>_` namespace prefix
 * (everything before the first '_') and converts the rest to kebab-case.
 * Mirrors the shortName extraction in `mca-service.updateToolPermission` /
 * `types/permissions.getToolPermission` so pending entries and permission
 * updates agree on identity.
 */
function normalizedShortToolName(toolName: string): string {
  const short = toolName.includes('_') ? toolName.split('_').slice(1).join('_') : toolName
  return short.replace(/_/g, '-')
}

export interface PendingApprovalsRegistryOpts {
  /** TTL for idempotency tracking. Default 5min. */
  resolvedTtlMs?: number
  /** Size threshold above which prune of resolved entries kicks in. Default 256. */
  resolvedPruneThreshold?: number
}

export class PendingApprovalsRegistry {
  private readonly pending = new Map<string, PendingPermission>()
  private readonly resolved = new Map<string, ResolvedRecord>()
  private readonly userIndex = new Map<string, Set<string>>()
  private readonly resolvedTtlMs: number
  private readonly resolvedPruneThreshold: number

  constructor(opts: PendingApprovalsRegistryOpts = {}) {
    this.resolvedTtlMs = opts.resolvedTtlMs ?? DEFAULT_RESOLVED_TTL_MS
    this.resolvedPruneThreshold = opts.resolvedPruneThreshold ?? DEFAULT_RESOLVED_PRUNE_THRESHOLD
  }

  // ---------------------------------------------------------------------------
  // Pending CRUD
  // ---------------------------------------------------------------------------

  /** Register a pending permission. Auto-indexes by userId for navbar. */
  register(requestId: string, perm: PendingPermission): void {
    this.pending.set(requestId, perm)
    if (perm.userId) this.addToUserIndex(perm.userId, requestId)
  }

  get(requestId: string): PendingPermission | undefined {
    return this.pending.get(requestId)
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  /** Delete pending AND clean user index. Returns true if it existed. */
  delete(requestId: string): boolean {
    const perm = this.pending.get(requestId)
    if (!perm) return false
    this.pending.delete(requestId)
    if (perm.userId) this.removeFromUserIndex(perm.userId, requestId)
    return true
  }

  size(): number {
    return this.pending.size
  }

  entries(): IterableIterator<[string, PendingPermission]> {
    return this.pending.entries()
  }

  /** True if there is any other pending in the same channel (excludeRequestId). */
  hasOtherPendingInChannel(channelId: string, excludeRequestId?: string): boolean {
    for (const [rid, p] of this.pending) {
      if (rid === excludeRequestId) continue
      if (p.channelId === channelId) return true
    }
    return false
  }

  /**
   * requestIds of every pending permission for one app tool. Matching is by
   * exact appId plus tool name compared on the kebab-normalised SHORT name
   * (the `<AppName>_` prefix stripped), so the caller can pass either the
   * namespaced runtime name or the bare catalog name.
   */
  findPendingByTool(appId: string, toolName: string): string[] {
    const wanted = normalizedShortToolName(toolName)
    const requestIds: string[] = []
    for (const [rid, p] of this.pending) {
      if (p.appId !== appId) continue
      if (normalizedShortToolName(p.toolName) !== wanted) continue
      requestIds.push(rid)
    }
    return requestIds
  }

  // ---------------------------------------------------------------------------
  // Idempotency (resolved TTL)
  // ---------------------------------------------------------------------------

  /** Record a resolution for idempotency. Duplicate handleResponse calls within
   * TTL return the stored resolution without side effects. */
  recordResolved(requestId: string, resolution: PermissionResolution): void {
    this.resolved.set(requestId, { at: Date.now(), resolution })
    if (this.resolved.size > this.resolvedPruneThreshold) {
      this.pruneResolved()
    }
  }

  isResolved(requestId: string): boolean {
    return this.resolved.has(requestId)
  }

  getResolved(requestId: string): ResolvedRecord | undefined {
    return this.resolved.get(requestId)
  }

  /** Manually prune expired entries. Called lazily on each recordResolved when
   * size > threshold; exposed for tests. */
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

  // ---------------------------------------------------------------------------
  // User-scoped index (for navbar indicator)
  // ---------------------------------------------------------------------------

  addToUserIndex(userId: string, requestId: string): void {
    let set = this.userIndex.get(userId)
    if (!set) {
      set = new Set<string>()
      this.userIndex.set(userId, set)
    }
    set.add(requestId)
  }

  removeFromUserIndex(userId: string, requestId: string): void {
    const set = this.userIndex.get(userId)
    if (!set) return
    set.delete(requestId)
    if (set.size === 0) this.userIndex.delete(userId)
  }

  /** Get summaries of all pending permissions for a user. */
  getUserPendingSummaries(userId: string): PendingPermissionSummary[] {
    const requestIds = this.userIndex.get(userId)
    if (!requestIds) return []
    const summaries: PendingPermissionSummary[] = []
    for (const rid of requestIds) {
      const p = this.pending.get(rid)
      if (!p) continue
      summaries.push({
        requestId: rid,
        toolName: p.toolName,
        appId: p.appId,
        channelId: p.channelId,
        messageId: p.messageId,
        toolCallId: p.toolCallId,
        irreversible: p.irreversible,
        timestamp: p.createdAt ?? Date.now(),
      })
    }
    return summaries
  }

  getUserPendingCount(userId: string): number {
    return this.userIndex.get(userId)?.size ?? 0
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Reset all state. Used at process shutdown or test teardown. */
  clear(): void {
    this.pending.clear()
    this.resolved.clear()
    this.userIndex.clear()
  }
}
