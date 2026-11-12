/**
 * Permission Manager
 *
 * Manages tool permission requests and responses.
 *
 * Permission requests are stored in memory AND persisted to channel_messages
 * so they can be restored after a page reload or backend restart.
 *
 * For restored permissions, when approved, the tool is executed and the
 * message is updated with the result.
 *
 * v4 permission cut (2026-10-27, Pablo direction — supersedes the 2026-10-25
 * v1 revert): the ask registers the pending permission EXACTLY as before
 * (widget UX untouched: same tool_permission_request broadcast, same
 * pending_permission persisted state) but returns the 'permission_requested'
 * marker IMMEDIATELY instead of parking the turn on a Promise. The executor
 * turns the marker into the tool result with endsTurn — the turn ends with
 * its REAL duration, so the user's thinking time falls between sessions and
 * never counts as agent-hours (the durationMs=30:00 bug). The grant/deny
 * arrives later and resolves SERVER-SIDE (restored-style: tool execution or
 * denial written into the history). PERMB-REQ-3: the agent wakes in a new turn
 * ONCE per batch, when the channel has no pending request left and every
 * resolution finished (onBatchResolved). NO synthetic user message is
 * ever emitted — the 2026-10-25 revert lesson ("Unsupported message type
 * event" + messages in the user's name) is baked in: the wake text is turn
 * input only (session store), never a channel bubble.
 */

import type { Db } from "mongodb"
import { captureException } from "../../lib/sentry"
import type { PermissionAskMarker } from "../../services/mca-tool-executor"
import {
  PendingApprovalsRegistry,
  type PendingPermission,
  type PendingPermissionSummary,
  type PermissionResolution,
} from "./pending-approvals-registry"

// Re-export for backwards compatibility — callers (message-handler, tests)
// import these from permission-manager.
export type { PendingPermission, PendingPermissionSummary, PermissionResolution }

/**
 * Context for the current tool call (used to link permission UI to the tool)
 *
 * TER-267: `messageId` is optional because the caller may pass an explicit
 * `toolCallId` that is not tracked in the current streamState (cross-session
 * singleton McaToolExecutor captures another channel's streamState). In that
 * case we still return the caller's `toolCallId` — it's more correct to emit
 * the permission widget with a correct tool-call-id and a missing message-id
 * than to cross-wire to the last streamed tool of a different agent.
 */
export interface ToolCallContext {
  messageId?: string
  toolCallId: string
  /** From the executor's stable map; absent on the untracked-id fallback. */
  toolName?: string
  /**
   * Catalog id of the tool's app, broadcast with tool_permission_request so
   * every surface can render the tool's own card. @spec PERMW-REQ-2
   */
  mcaId?: string
}

/**
 * Callbacks for tool status updates during permission flow
 */
export interface PermissionStatusCallbacks {
  /**
   * Called when tool enters pending_permission state.
   * `irreversible` is the binary annotation from the tool manifest
   * (Renderer UX Guide v2 §8). Defaults to `false`.
   */
  onPendingPermission?: (
    permissionRequestId: string,
    appId: string,
    irreversible: boolean,
    toolCallId?: string,
  ) => Promise<void>
  /** Called when permission is granted and tool is about to execute */
  onPermissionGranted?: (toolCallId?: string) => Promise<void>
}

/**
 * Callback to execute a restored tool and update the message.
 * `appId` and `workspaceId` come from the persisted permission request so the
 * restored execution targets the exact workspace-scoped app instance instead
 * of re-resolving by name (incident-2026-08-14).
 */
export type RestoredToolExecutor = (params: {
  channelId: string
  messageId: string
  toolCallId: string
  toolName: string
  input: Record<string, any>
  appId?: string
  workspaceId?: string
}) => Promise<void>

/**
 * Globally unique request ID via crypto.randomUUID. Eliminates multi-worker (PM2)
 * collisions, timestamp ties when two events land in the same ms, and counter
 * overflow on long-uptime systems. Module-level helper because it has no instance
 * state (pure function).
 */
function generatePermissionRequestId(): string {
  return `perm_${crypto.randomUUID()}`
}

export interface PermissionManagerDeps {
  broadcastToChannel: (channelId: string, message: any) => void
  broadcastToUser?: (userId: string, message: any) => void
  onExternalActionChange?: (channelId: string, requested: boolean) => void
  /** Database for persisting permission state */
  db?: Db
  /**
   * GAP-11: Optional hook to verify a tool still exists for an app before restoring
   * its pending permission. Useful when MCAs are updated during a backend downtime —
   * restored requests pointing to removed tools would otherwise be unanswerable.
   * If omitted, restore proceeds without validation (legacy behaviour).
   */
  validateToolExists?: (appId: string, toolName: string) => Promise<boolean>
  /** Optional: update a tool message in DB to 'failed' status when a restored tool no longer exists. */
  updateMessageStatus?: (messageId: string, status: 'failed', extra?: Record<string, unknown>) => Promise<void>
  /**
   * TER-338: Resolve the observer channel (typically the parent / originChannelId) for a
   * given channelId. Used to dual-broadcast permission events so the human watching the
   * parent conversation can approve/deny tools triggered by a delegated sub-agent without
   * having to navigate to the sub-channel manually. Return null if the channel has no
   * observer (most flows — single-agent, direct conversation).
   */
  resolveObserverChannelId?: (channelId: string) => Promise<string | null>
  /**
   * PERMB-REQ-3: called ONCE per batch to WAKE the agent in a NEW turn, when
   * the channel has no pending request left and every resolution of the batch
   * (grant executions, deny rewrites) has finished. `outcomes` lists every
   * decision since the last wake, in decision order. MessageHandler wires
   * this to processAgentResponse with `buildPermissionBatchWakeText`.
   * NO synthetic user message is ever emitted — the wake text is turn input
   * (session store), never a channel bubble (2026-10-25 revert lesson).
   * @spec PERMB-REQ-3
   */
  onBatchResolved?: (args: {
    channelId: string
    outcomes: PermissionBatchOutcome[]
  }) => Promise<void>
  /**
   * PERMB-REQ-3: rewrite the session-store tool part of a DENIED request with
   * the denial as an error result, so the agent's history never keeps the
   * `permission_requested` marker for a decided request. The grant path
   * rewrites its part inside the RestoredToolExecutor.
   * @spec PERMB-REQ-3
   */
  rewriteDeniedToolPart?: (args: {
    channelId: string
    toolCallId: string
    toolName: string
    output: string
  }) => Promise<void>
}

/**
 * One decided (or expired) request of a permission batch.
 * - `granted`: approved and executed (the tool result is in the history).
 * - `granted_not_executed`: approved, but the tool could not be executed
 *   server-side (no execution context, or the executor threw).
 * - `denied`: refused by the user (the denial is in the history).
 * - `expired`: never answered — listed only when the batch had a decision.
 * @spec PERMB-REQ-3
 */
export interface PermissionBatchOutcome {
  toolName: string
  outcome: 'granted' | 'granted_not_executed' | 'denied' | 'expired'
}

/** The error result written into the session-store tool part on deny (PERMB-REQ-3). */
export function permissionDeniedToolOutput(toolName: string): string {
  return `Permission denied: User declined to allow execution of '${toolName}'.`
}

/**
 * The single wake text of a permission batch. Empty sections are omitted.
 * @spec PERMB-REQ-3
 */
export function buildPermissionBatchWakeText(outcomes: PermissionBatchOutcome[]): string {
  const names = (kind: PermissionBatchOutcome['outcome']) =>
    outcomes.filter((o) => o.outcome === kind).map((o) => `'${o.toolName}'`)
  const approved = names('granted')
  const notExecuted = names('granted_not_executed')
  const denied = names('denied')
  const expired = names('expired')
  const sections: string[] = []
  if (approved.length > 0) {
    sections.push(
      `Approved and executed: ${approved.join(', ')} — ${approved.length === 1 ? 'its result is' : 'their results are'} in the tool history above.`,
    )
  }
  if (notExecuted.length > 0) {
    sections.push(
      `Approved but not executed: ${notExecuted.join(', ')} — the tool could not be executed automatically (its execution context is no longer available); do not retry it blindly, ask the user how to proceed if needed.`,
    )
  }
  if (denied.length > 0) {
    sections.push(
      `Denied: ${denied.join(', ')} — do not retry ${denied.length === 1 ? 'it' : 'them'}; continue conversationally (ask what to do instead if needed).`,
    )
  }
  if (expired.length > 0) {
    sections.push(`Not answered (expired): ${expired.join(', ')}.`)
  }
  return `[Permission] The user decided on the pending tool calls of your last turn. ${sections.join(' ')}`
}


/**
 * Creates a permission manager for handling tool permission requests
 */
export function createPermissionManager(deps: PermissionManagerDeps) {
  const {
    broadcastToChannel,
    broadcastToUser,
    onExternalActionChange,
    db,
    validateToolExists,
    updateMessageStatus,
    resolveObserverChannelId,
    onBatchResolved,
    rewriteDeniedToolPart,
  } = deps

  // ---------------------------------------------------------------------------
  // In-memory state — encapsulated in a PendingApprovalsRegistry instance.
  // The class owns pending+resolved+userIndex Maps with invariants enforced by
  // its API; we just compose it with broadcasts + DB. Instance-local so
  // multiple PermissionManagers in tests stay isolated.
  // ---------------------------------------------------------------------------

  const registry = new PendingApprovalsRegistry()

  /**
   * PERMB-REQ-3: per-channel permission batch — the outcomes decided since the
   * last wake and the number of resolutions still doing their work (grant
   * executions, deny rewrites). In memory only: after a restart the wake
   * lists only the decisions made after it (PERMB-NFR-1).
   */
  const batches = new Map<string, { outcomes: PermissionBatchOutcome[]; inFlight: number }>()

  /**
   * PERMB-REQ-3: granted tools of a batch execute ONE AT A TIME per channel,
   * in decision order — the sequential default of the turn. "Always allow"
   * released three `recall` calls at once (2026-10-28) and the app's MCP
   * session could not take concurrent calls; the turn never runs a channel's
   * tools concurrently, so neither does the grant path. A rejected execution
   * never blocks the next one.
   * @spec PERMB-REQ-3
   */
  const executionChains = new Map<string, Promise<void>>()
  function runSequentially(channelId: string, work: () => Promise<void>): Promise<void> {
    const previous = executionChains.get(channelId) ?? Promise.resolve()
    const run = previous.then(work, work)
    const settled = run.catch(() => undefined)
    executionChains.set(channelId, settled)
    void settled.then(() => {
      if (executionChains.get(channelId) === settled) executionChains.delete(channelId)
    })
    return run
  }

  function getBatch(channelId: string) {
    let batch = batches.get(channelId)
    if (!batch) {
      batch = { outcomes: [], inFlight: 0 }
      batches.set(channelId, batch)
    }
    return batch
  }

  /**
   * PERMB-REQ-3: wake the agent once the batch is complete — no pending
   * request left in the channel, no resolution in flight, at least one
   * outcome. The check + clear are synchronous, so concurrent resolutions
   * ("Allow all" fires N requests) can never wake twice.
   * @spec PERMB-REQ-3
   */
  async function maybeWakeBatch(channelId: string): Promise<void> {
    const batch = batches.get(channelId)
    if (!batch || batch.inFlight > 0 || batch.outcomes.length === 0) return
    if (hasOtherPendingInChannel(channelId)) return
    batches.delete(channelId)
    if (!onBatchResolved) return
    try {
      await onBatchResolved({ channelId, outcomes: batch.outcomes })
    } catch (err) {
      console.error(`[PermissionManager] onBatchResolved (wake) failed:`, err)
    }
  }

  /** Broadcast the user-scoped pending permissions count to the navbar indicator. */
  function emitUserPendingPermissionsChanged(userId: string): void {
    if (!broadcastToUser) return
    const permissions = registry.getUserPendingSummaries(userId)
    broadcastToUser(userId, {
      type: "user_pending_permissions_changed",
      userId,
      count: permissions.length,
      permissions,
    })
  }

  /**
   * Broadcast a permission-related event al canal del ejecutor y a TODA la cadena
   * de canales observadores (parent → grandparent → ...) hasta el root o el hard
   * limit de hops. Cada emisión incluye `channelId: <destino>` explícito en el payload
   * (sin esto el frontend hace early return en PendingApprovalsWindowContent), y en
   * el caso del observer también `observedChannelId: <canal del ejecutor original>`
   * para que el frontend sepa que la card vive en otro canal.
   *
   * Anti-loop: `Set<seen>` corta cualquier referencia circular (A.origin=B && B.origin=A)
   * y el hard limit MAX_OBSERVER_HOPS (5) actúa como cinturón si la cadena es
   * ilegítimamente larga.
   */
  const MAX_OBSERVER_HOPS = 5

  async function broadcastToChannelAndObservers(
    channelId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    // Siempre emitir al ejecutor con su channelId en el payload
    broadcastToChannel(channelId, { ...event, channelId })

    if (!resolveObserverChannelId) return

    const seen = new Set<string>([channelId])
    let current = channelId
    let hops = 0

    while (hops < MAX_OBSERVER_HOPS) {
      let observerChannelId: string | null = null
      try {
        observerChannelId = await resolveObserverChannelId(current)
      } catch (err) {
        console.warn(
          '[PermissionManager] resolveObserverChannelId threw — stopping observer chain',
          { channelId: current, hops, err },
        )
        return
      }

      if (!observerChannelId) return
      if (seen.has(observerChannelId)) {
        console.warn(
          '[PermissionManager] Observer chain has a cycle — stopping',
          { startChannelId: channelId, cycleAt: observerChannelId, hops },
        )
        return
      }

      seen.add(observerChannelId)
      hops++

      // observedChannelId = canal del ejecutor original (no el padre intermedio)
      // para que el frontend pueda anchor a la tool card correcta.
      broadcastToChannel(observerChannelId, {
        ...event,
        channelId: observerChannelId,
        observedChannelId: channelId,
      })

      current = observerChannelId
    }

    if (hops === MAX_OBSERVER_HOPS) {
      console.warn(
        '[PermissionManager] Observer chain hit MAX_OBSERVER_HOPS — root may not have been reached',
        { startChannelId: channelId, lastBroadcast: current, hops },
      )
    }
  }

  /**
   * Update channel_messages tool status
   */
  async function updateChannelMessageStatus(
    messageId: string,
    status: string,
    extra?: Record<string, any>,
  ): Promise<void> {
    if (!db) return

    try {
      const channelMessages = db.collection("channel_messages")
      const update: Record<string, any> = { "content.status": status }

      if (extra) {
        for (const [key, value] of Object.entries(extra)) {
          update[`content.${key}`] = value
        }
      }

      await channelMessages.updateOne({ messageId }, { $set: update })
    } catch (error) {
      console.error(`[PermissionManager] Failed to update message status:`, error)
    }
  }

  /**
   * Check if there are still pending permissions for a channel.
   * Thin wrapper over registry — keeps the call site readable.
   */
  function hasOtherPendingInChannel(channelId: string, excludeRequestId?: string): boolean {
    return registry.hasOtherPendingInChannel(channelId, excludeRequestId)
  }

  /**
   * Notify channel about external action status change
   */
  function notifyExternalActionChange(channelId: string, requested: boolean): void {
    broadcastToChannel(channelId, {
      type: "channel_status",
      channelId,
      externalActionRequested: requested,
    })
    onExternalActionChange?.(channelId, requested)
  }

  return {
    /**
     * Create a callback for asking permission to execute a tool
     * @param channelId - The channel where permission is requested
     * @param getToolCallContext - Function to get current tool call context (messageId, toolCallId)
     * @param statusCallbacks - Optional callbacks for tool status updates
     *
     * The tool_permission_request broadcast carries `mcaId` (from the tool
     * call context) and `irreversible` (PERMW-REQ-2).
     * @spec PERMW-REQ-2
     */
    createAskPermissionCallback(
      channelId: string,
      userId: string,
      getToolCallContext?: (toolCallId?: string) => ToolCallContext | null,
      statusCallbacks?: PermissionStatusCallbacks,
      workspaceId?: string,
    ) {
      return async (
        toolName: string,
        appId: string,
        input: Record<string, any>,
        irreversible: boolean,
        toolCallId?: string,
        /** 🛡️ Teros Guard: set when the ask is guard-forced — broadcast so the UI can show why. */
        guardReason?: string,
      ): Promise<PermissionResolution | PermissionAskMarker> => {
        // v4 permission cut (2026-10-27, Pablo direction): the ask registers
        // the pending permission EXACTLY as before (widget UX untouched —
        // same tool_permission_request broadcast, same pending_permission
        // persisted state) but returns the 'permission_requested' marker
        // IMMEDIATELY instead of parking the turn on a Promise. The executor
        // turns the marker into the tool result (endsTurn) and the turn ends
        // with its REAL duration — the user's thinking time falls between
        // sessions and never counts as agent-hours. The grant/deny arrives
        // later and resolves server-side (tool + wake in a new turn).
        const requestId = generatePermissionRequestId()

        // Get tool call context for linking UI to the tool.
        // Defense: wrap in try/catch — if the lookup throws (e.g. streamState
        // mutated under us, Map iteration error) the request must not hang.
        let context: ToolCallContext | null = null
        try {
          context = getToolCallContext?.(toolCallId) ?? null
        } catch (err) {
          console.error(
            `[PermissionManager] getToolCallContext threw — auto-denying ${toolName}`,
            { channelId, toolCallId, toolName, err },
          )
          captureException(
            err as Error,
            {
              context: "getToolCallContext",
              toolCallId,
              toolName,
            },
            { userId, channelId, appId },
          )
          return 'denied'
        }

        // SECURITY: auto-forbid when we cannot link the permission request to a
        // specific chat message. Without messageId there is no inline UI anchor,
        // no audit trail, and the frontend cannot render a ControlsBar. The
        // frontend currently auto-denies these requests (useChatPermissions.ts),
        // but relying on the client for security is a fail-open path. We deny
        // immediately in the backend so the tool never executes.
        if (getToolCallContext && (!context || !context.messageId)) {
          console.warn(
            `[PermissionManager] Auto-forbidding tool '${toolName}' — cannot link permission request to a chat message (context: ${context ? 'missing messageId' : 'null'})`,
          )
          return 'denied'
        }

        // Update tool status to pending_permission (with requestId, appId, and
        // irreversible flag for the frontend Irreversibility Indicator). If the
        // status update fails the user would never see a modal — the request
        // would hang unanswered forever. Better to clean up + deny immediately
        // (awaited: the ask must not return the marker when the widget can
        // never render — GAP-8 defense).
        const pendingPromise = statusCallbacks
          ?.onPendingPermission?.(requestId, appId, irreversible, context?.toolCallId)
        if (pendingPromise) {
          try {
            await pendingPromise
          } catch (err) {
            console.error(
              "[PermissionManager] onPendingPermission failed — cleaning up and auto-denying",
              { requestId, channelId, toolCallId, err },
            )
            const stillPending = registry.get(requestId)
            if (stillPending) {
              registry.delete(requestId) // also removes from user index
              registry.recordResolved(requestId, 'denied')
              // Emit navbar update — sin esto el contador queda inflado
              // mostrando un permiso que ya no existe.
              if (stillPending.userId) {
                emitUserPendingPermissionsChanged(stillPending.userId)
              }
            }
            return 'denied'
          }
        }

        // Capture toolCallId for the restored-style resolution
        const capturedToolCallId = context?.toolCallId

        // Store pending request. registry.register() also auto-indexes by userId
        // for the navbar indicator (no manual addToUserIndex needed).
        // v4: resolve/reject are no-ops kept for the registry type — there is
        // no parked executor promise to unblock (the turn already ended).
        registry.register(requestId, {
          resolve: (resolution: PermissionResolution) => {
            // v4: no live turn to unblock — the ask already ended the turn with
            // the 'permission_requested' marker. The resolution runs
            // server-side through handleResponse (tool + wake). Kept as a
            // required field by the registry type; a no-op.
            void resolution
          },
          reject: (error: Error) => {
            // v4: idem — nothing parked to reject. Log so a stray call is
            // never silent (no-empty-catch).
            console.error('[PermissionManager] reject() on a nonBlocking pending (no-op)', {
              requestId,
              channelId,
              error,
            })
          },
          toolName,
          appId,
          mcaId: context?.mcaId,
          input,
          channelId,
          messageId: context?.messageId,
          toolCallId: capturedToolCallId,
          userId,
          irreversible,
          createdAt: Date.now(),
          workspaceId,
          nonBlocking: true,
        })

        // Broadcast updated count to navbar
        emitUserPendingPermissionsChanged(userId)

        // Send permission request to client with context for inline UI.
        // TER-338: dual-broadcast — also emit to the observer (parent) channel when
        // the executor channel is a delegated/headless sub-channel, so the human
        // can approve from where they actually are. Fire-and-forget — the observer
        // lookup is async but we don't block the resolution loop on it.
        broadcastToChannelAndObservers(channelId, {
          type: "tool_permission_request",
          requestId,
          toolName,
          appId,
          // PERMW-REQ-2: what the tool's own card needs on every surface.
          mcaId: context?.mcaId,
          irreversible,
          // 🛡️ Teros Guard: present only when the ask was guard-forced —
          // the modal shows WHY (Fase 2 renders it; the field is inert now).
          ...(guardReason ? { guardReason } : {}),
          input,
          // Include context so frontend can update the correct tool call
          messageId: context?.messageId,
          toolCallId: context?.toolCallId,
          timestamp: Date.now(),
        }).catch((err) => {
          console.error('[PermissionManager] broadcastToChannelAndObservers failed:', err)
        })

        // Notify channel that external action is requested
        notifyExternalActionChange(channelId, true)

        console.log(
          `[PermissionManager] Permission request sent: ${requestId} for ${toolName} (msg: ${context?.messageId}, tool: ${context?.toolCallId}) — turn ends, grant/deny arrives later`,
        )

        // v4 permission cut: the tool call is only "ask the user". The executor
        // turns this marker into the tool result (isError: false — NOT a deny);
        // the turn ends deterministically (endsTurn). handleResponse owns
        // everything that happens afterwards. The requestId travels IN the
        // marker so the executor can serialize it into the awaiting-user
        // output — the frontend renders the inline ControlsBar from that JSON
        // (completeToolMessage drops permissionRequestId from the content).
        return { kind: 'requested', requestId }
      }
    },

    /**
     * Handle permission response from client
     * For restored permissions, executes the tool if granted
     *
     * PERMB-REQ-3: a grant executes the tool (channel message + session part
     * rewritten by the RestoredToolExecutor); a deny writes the failure into
     * the channel message and the denial into the session part. Neither
     * wakes by itself — the batch wakes once, when it is complete.
     * @spec PERMB-REQ-3
     */
    async handleResponse(
      requestId: string,
      granted: boolean,
      restoredToolExecutor?: RestoredToolExecutor,
    ): Promise<{ channelId: string; toolName: string; idempotent?: boolean } | null> {
      const pending = registry.get(requestId)
      if (!pending) {
        // GAP-7: distinguish "already resolved" from "never existed". A duplicate
        // grant/deny (network retry, double-click) is benign idempotency; an unknown
        // requestId is a real bug worth investigating.
        const prior = registry.getResolved(requestId)
        if (prior) {
          console.log(
            `[PermissionManager] handleResponse for already-resolved request ${requestId} ` +
              `(prior: ${prior.resolution}, now: ${granted ? 'granted' : 'denied'}) — idempotent no-op`,
          )
          return { channelId: '', toolName: '', idempotent: true }
        }
        console.warn(`[PermissionManager] No pending permission request found: ${requestId}`)
        return null
      }

      // Remove from pending (also cleans userIndex inside registry.delete) and
      // record the resolution for idempotency.
      registry.delete(requestId)
      registry.recordResolved(requestId, granted ? 'granted' : 'denied')

      // Emit navbar update for the user (delete already removed from index).
      if (pending.userId) {
        emitUserPendingPermissionsChanged(pending.userId)
      }

      // Check if there are still pending permissions for this channel
      if (!hasOtherPendingInChannel(pending.channelId)) {
        notifyExternalActionChange(pending.channelId, false)
      }

      console.log(
        `[PermissionManager] Permission ${granted ? "granted" : "denied"} for request: ${requestId} (restored: ${pending.restored}, nonBlocking: ${pending.nonBlocking})`,
      )

      // v4 permission cut (2026-10-27): nonBlocking pendings (the ask ended the
      // turn with the 'permission_requested' marker) resolve SERVER-SIDE,
      // exactly like restored pendings: the tool executes with the persisted
      // input (grant) or the failure is persisted (deny), then the agent wakes
      // in a NEW turn. There is no parked executor promise to resolve.
      // Fire-and-forget: the wake runs a full LLM turn, and awaiting it inside
      // the WS request blows the client's 10s request timeout (the resolution
      // itself — registry delete + recordResolved above — has already
      // happened, so the ack is safe to return now). Same pattern as the form
      // flow's finalizeIntoChannel.
      if (pending.restored || pending.nonBlocking) {
        // PERMB-REQ-3: count this resolution as in flight SYNCHRONOUSLY,
        // before any async work — "Allow all" fires N requests back to back
        // and none of them may see an empty batch while another is running.
        const batch = getBatch(pending.channelId)
        batch.inFlight++
        // Recorded at decision time so the wake lists outcomes in decision
        // order even though executions are queued (PERMB-REQ-3); the entry is
        // amended if the execution fails. The wake cannot run while this
        // resolution is in flight, so the entry is final by then.
        const entry: PermissionBatchOutcome = {
          toolName: pending.toolName,
          outcome: granted ? 'granted' : 'denied',
        }
        batch.outcomes.push(entry)
        void (async () => {
          let outcome: PermissionBatchOutcome['outcome'] = entry.outcome
          try {
            if (granted && restoredToolExecutor && pending.messageId && pending.toolCallId) {
              // Execute the tool and update the message + the session part
              // (the executor no longer wakes — the batch does).
              try {
                const executeThis = () =>
                  restoredToolExecutor({
                    channelId: pending.channelId,
                    messageId: pending.messageId as string,
                    toolCallId: pending.toolCallId as string,
                    toolName: pending.toolName,
                    input: pending.input,
                    appId: pending.appId,
                    workspaceId: pending.workspaceId,
                  })
                await runSequentially(pending.channelId, executeThis)
              } catch (error) {
                outcome = 'granted_not_executed'
                console.error(`[PermissionManager] Failed to execute restored tool:`, error)
                // Update message to failed
                await updateChannelMessageStatus(pending.messageId, "failed", {
                  error: `Error executing tool: ${error instanceof Error ? error.message : String(error)}`,
                  permissionRequestId: undefined,
                }).catch((err) => {
                  console.error('[PermissionManager] failed to persist tool failure', {
                    requestId,
                    messageId: pending.messageId,
                    err,
                  })
                })
                broadcastToChannel(pending.channelId, {
                  type: "message_chunk",
                  channelId: pending.channelId,
                  messageId: pending.messageId,
                  chunkType: "tool_status_update",
                  toolCallId: pending.toolCallId,
                  toolStatus: "failed",
                  timestamp: Date.now(),
                })
              }
            } else if (granted) {
              // A grant without an execution context (no executor / message /
              // toolCallId): nothing ran.
              outcome = 'granted_not_executed'
            } else {
              if (pending.messageId) {
                // Update message to failed
                await updateChannelMessageStatus(pending.messageId, "failed", {
                  error: "Permission denied by user",
                  permissionRequestId: undefined,
                }).catch((err) => {
                  console.error('[PermissionManager] failed to persist deny', {
                    requestId,
                    messageId: pending.messageId,
                    err,
                  })
                })
                broadcastToChannel(pending.channelId, {
                  type: "message_chunk",
                  channelId: pending.channelId,
                  messageId: pending.messageId,
                  chunkType: "tool_status_update",
                  toolCallId: pending.toolCallId,
                  toolStatus: "failed",
                  timestamp: Date.now(),
                })
              }
              // PERMB-REQ-3: the denial replaces the marker in the agent's
              // history (session-store tool part, as an error result).
              if (rewriteDeniedToolPart && pending.toolCallId) {
                try {
                  await rewriteDeniedToolPart({
                    channelId: pending.channelId,
                    toolCallId: pending.toolCallId,
                    toolName: pending.toolName,
                    output: permissionDeniedToolOutput(pending.toolName),
                  })
                } catch (err) {
                  console.error('[PermissionManager] failed to rewrite the denied tool part', {
                    requestId,
                    toolCallId: pending.toolCallId,
                    err,
                  })
                }
              }
            }
          } finally {
            // PERMB-REQ-3: this resolution is settled — record its outcome
            // and wake once if it completed the batch. Fire-and-forget
            // relative to the WS request (we are already detached from it).
            const current = getBatch(pending.channelId)
            entry.outcome = outcome
            current.inFlight = Math.max(0, current.inFlight - 1)
            await maybeWakeBatch(pending.channelId)
          }
        })()
      } else {
        // Normal flow - resolve the promise (pre-v4 rows only; impossible
        // after deploy because every ask registers nonBlocking).
        pending.resolve(granted ? 'granted' : 'denied')
      }

      return { channelId: pending.channelId, toolName: pending.toolName }
    },

    /**
     * Get pending permission count (for debugging)
     */
    getPendingCount(): number {
      return registry.size()
    },

    /**
     * True if any permission is still pending in this channel — used by the
     * message-handler to compute the channel's awaiting_user state
     * (broadcastAwaitingUserAfterResolution — forms/auth v2 chip recompute).
     * Kept from dev when permissions reverted to v1: the awaiting_user
     * chip remains a forms/auth mechanic.
     */
    hasPendingInChannel(channelId: string): boolean {
      return hasOtherPendingInChannel(channelId)
    },

    /**
     * requestIds of every pending request for one app tool. Used when the
     * user persists a per-tool permission ("Allow always" / "Deny always"):
     * the caller resolves each id through handleResponse so the in-flight
     * requests of that same tool follow the new permission instead of
     * waiting for an individual click.
     */
    findPendingRequestIdsForTool(appId: string, toolName: string): string[] {
      return registry.findPendingByTool(appId, toolName)
    },

    /**
     * Get pending permission count for a specific user (for navbar indicator)
     */
    getPendingPermissionCount(userId: string): number {
      return registry.getUserPendingCount(userId)
    },

    /**
     * Get pending permission summaries for a specific user
     */
    getPendingPermissionsForUser(userId: string): PendingPermissionSummary[] {
      return registry.getUserPendingSummaries(userId)
    },

    /**
     * Clear all pending permissions (for cleanup).
     * Resolves non-restored requests as denied first so no executor hangs.
     */
    clearAll(): void {
      for (const [_requestId, pending] of registry.entries()) {
        // v4: nonBlocking pendings have no executor promise to resolve —
        // the registry clear below is all they need (the turn already ended).
        if (!pending.restored && !pending.nonBlocking) {
          pending.resolve('denied')
        }
      }
      registry.clear()
      batches.clear()
    },

    /**
     * Find pending permission messages in channel_messages
     * Looks for messages with status 'pending_permission' that have permissionRequestId
     *
     * PERMB-REQ-2: a pending request never expires by age — a v4 request
     * carries no turn, so it lives until the user decides or an explicit
     * cancellation (cancelPermissionsForChannel, removed tool) resolves it.
     * Every `pending_permission` row is returned, whatever its age (the
     * incident-2026-08-14 TTL targeted orphans of dead v1 turns).
     * PERMW-REQ-2: each row also carries `mcaId` and `irreversible` from the
     * persisted tool content so the restored broadcast matches the live one.
     * @spec PERMB-REQ-2
     * @spec PERMW-REQ-2
     */
    async findPendingApprovals(channelId: string): Promise<
      Array<{
        toolCallId: string
        toolName: string
        appId: string
        mcaId?: string
        irreversible: boolean
        requestId: string
        input: any
        messageId: string
        workspaceId?: string
      }>
    > {
      if (!db) return []

      try {
        const channelMessages = db.collection("channel_messages")

        // Find messages with pending_permission status
        const messages = await channelMessages
          .find({
            channelId,
            "content.type": "tool_execution",
            "content.status": "pending_permission",
          })
          .toArray()

        const pendingApprovals: Array<{
          toolCallId: string
          toolName: string
          appId: string
          mcaId?: string
          irreversible: boolean
          requestId: string
          input: any
          messageId: string
          workspaceId?: string
        }> = []

        for (const msg of messages) {
          const content = msg.content
          if (content?.permissionRequestId && content?.appId) {
            pendingApprovals.push({
              toolCallId: content.toolCallId,
              toolName: content.toolName,
              appId: content.appId,
              mcaId: content.mcaId,
              irreversible: content.irreversible === true,
              requestId: content.permissionRequestId,
              input: content.input || {},
              messageId: msg.messageId,
              workspaceId: content.workspaceId,
            })
          }
        }

        return pendingApprovals
      } catch (error) {
        console.error(`[PermissionManager] Failed to find pending approvals:`, error)
        return []
      }
    },

    /**
     * Expire a single orphaned permission request — marks the
     * `channel_messages` document as `failed` and broadcasts the
     * status change so the frontend removes the stale modal.
     *
     * incident-2026-08-14: called from `cancelPermissionsForChannel` when
     * INV-1 reconciliation fails. Never called by age (PERMB-REQ-2).
     *
     * PERMB-REQ-3: never wakes by itself; completes (and wakes) a batch in
     * which the user already decided at least one request.
     * @spec PERMB-REQ-3
     */
    async expirePermission(
      messageId: string,
      requestId: string,
      channelId: string,
      reason?: string,
    ): Promise<void> {
      if (!db) return

      try {
        const channelMessages = db.collection("channel_messages")
        await channelMessages.updateOne(
          { messageId },
          {
            $set: {
              "content.status": "failed",
              "content.error": reason ?? "Permission expired — the requesting turn is no longer active",
              "content.permissionRequestId": undefined,
            },
          },
        )

        // Also clean from in-memory registry if present (e.g. restored
        // but then expired on a subsequent subscribe)
        // Moved BEFORE broadcast so we can include toolCallId in the payload.
        const pending = registry.get(requestId)
        if (pending) {
          registry.delete(requestId)
          registry.recordResolved(requestId, 'denied')
          if (pending.userId) {
            emitUserPendingPermissionsChanged(pending.userId)
          }
          if (!hasOtherPendingInChannel(pending.channelId)) {
            notifyExternalActionChange(pending.channelId, false)
          }
          // v4 permission cut: a nonBlocking pending has no executor promise
          // to resolve (the turn already ended) — the DB cleanup above is all
          // it needs. (The old @fixme about the parked promise hanging until
          // the turn-deadline is obsolete — there is no parked promise.)
          if (!pending.restored && !pending.nonBlocking) {
            pending.resolve('denied')
          }
          // PERMB-REQ-3: an expiry never wakes by itself. Only when the user
          // already decided part of this batch is the expired request listed
          // (as not answered) — and if it was the last pending one, that
          // completes the batch and the wake happens now. Fire-and-forget:
          // callers (channel cancellation) never wait on an LLM turn.
          const batch = batches.get(pending.channelId)
          if (batch && (batch.outcomes.length > 0 || batch.inFlight > 0)) {
            batch.outcomes.push({ toolName: pending.toolName, outcome: 'expired' })
            void maybeWakeBatch(pending.channelId)
          }
        }

        // Broadcast the status change so the frontend removes the modal.
        // Include toolCallId and permissionRequestId: undefined so the
        // frontend's tool_status_update handler can find the message in
        // the store and clear the permission widget.
        broadcastToChannel(channelId, {
          type: "message_chunk",
          channelId,
          messageId,
          toolCallId: pending?.toolCallId,
          chunkType: "tool_status_update",
          toolStatus: "failed",
          permissionRequestId: undefined,
          timestamp: Date.now(),
        })
      } catch (error) {
        console.error(`[PermissionManager] Failed to expire permission ${requestId}:`, error)
      }
    },

    /**
     * Cancel ALL pending permission requests for a channel.
     *
     * incident-2026-08-14: called by ResumeService when INV-1
     * reconciliation fails (recovered=false) — the turn is dead and
     * any pending permissions it created are orphaned. Without this
     * they would persist in DB indefinitely and be re-broadcast on
     * every subscribe.
     */
    async cancelPermissionsForChannel(channelId: string, reason: string): Promise<number> {
      if (!db) return 0

      try {
        const channelMessages = db.collection("channel_messages")
        const stale = await channelMessages
          .find({
            channelId,
            "content.type": "tool_execution",
            "content.status": "pending_permission",
          })
          .toArray()

        let cancelled = 0
        for (const msg of stale) {
          const content = msg.content
          if (content?.permissionRequestId) {
            await this.expirePermission(
              msg.messageId,
              content.permissionRequestId,
              channelId,
              reason,
            )
            cancelled++
          }
        }

        if (cancelled > 0) {
          console.log(
            `[PermissionManager] Cancelled ${cancelled} pending permission(s) for channel ${channelId}: ${reason}`,
          )
        }

        return cancelled
      } catch (error) {
        console.error(`[PermissionManager] Failed to cancel permissions for channel ${channelId}:`, error)
        return 0
      }
    },

    /**
     * Restore pending permission requests for a channel
     * Called when a user subscribes to a channel
     *
     * This:
     * 1. Finds pending_permission messages in channel_messages
     * 2. Registers them in memory so handleResponse works
     * 3. Sends tool_permission_request to the client (with `mcaId` and
     *    `irreversible`, like the live request — PERMW-REQ-2)
     * @spec PERMW-REQ-2
     */
    async restorePendingApprovals(channelId: string): Promise<number> {
      const pendingApprovals = await this.findPendingApprovals(channelId)

      if (pendingApprovals.length === 0) {
        return 0
      }

      console.log(
        `[PermissionManager] Restoring ${pendingApprovals.length} pending approval(s) for channel ${channelId}`,
      )

      // Count effectively restored (validated + broadcast). Differs from
      // pendingApprovals.length when GAP-11 validation skips some.
      let restoredCount = 0

      for (const approval of pendingApprovals) {
        const alreadyRegistered = registry.has(approval.requestId)

        // Verify the tool still exists for the app. The MCA may have been updated
        // during downtime — re-broadcasting a request for a removed tool would let
        // the user grant it but execution would fail at runtime. Skip this validation
        // when the entry is already registered — it was validated (and is still alive)
        // when first created.
        if (!alreadyRegistered && validateToolExists) {
          const stillExists = await validateToolExists(approval.appId, approval.toolName)
          if (!stillExists) {
            console.warn(
              `[PermissionManager] Restored permission targets removed tool '${approval.toolName}' ` +
                `(app ${approval.appId}) — marking message failed and skipping broadcast`,
              { channelId, requestId: approval.requestId, messageId: approval.messageId },
            )
            if (updateMessageStatus) {
              await updateMessageStatus(approval.messageId, 'failed', {
                error: `Tool '${approval.toolName}' is no longer available — pending approval discarded`,
                permissionRequestId: undefined,
              }).catch((err) => {
                console.error('[PermissionManager] Failed to mark restored message as failed:', err)
              })
            }
            continue
          }
        }

        // Lookup userId to build the user-scoped index for the navbar indicator.
        let userId: string | undefined
        try {
          if (db) {
            const channel = await db.collection("channels").findOne({ channelId })
            userId = channel?.userId ?? undefined
          }
        } catch {
          /* ignore lookup errors */
        }

        // Register in memory (only when not already there) — avoids duplicate Map
        // entries on repeated subscribes, but does NOT skip the broadcast below.
        // BUG fixed: previously this loop did `continue` when alreadyRegistered,
        // which skipped the re-broadcast and left subscribers without the event,
        // so a user navigating to a sub-channel after the original tool_permission_request
        // had been sent (to a channel with no subscribers) never saw the modal.
        if (!alreadyRegistered) {
          // registry.register also auto-indexes by userId for the navbar.
          registry.register(approval.requestId, {
            resolve: () => {}, // No-op for restored permissions
            reject: () => {},
            toolName: approval.toolName,
            appId: approval.appId,
            mcaId: approval.mcaId,
            input: approval.input,
            channelId,
            messageId: approval.messageId,
            toolCallId: approval.toolCallId,
            restored: true,
            irreversible: approval.irreversible,
            userId,
            createdAt: Date.now(),
            workspaceId: approval.workspaceId,
          })
        }

        // Send permission request to client. Always re-broadcast — a fresh subscriber
        // (user navigating to a sub-channel for the first time, page reload, second
        // tab) needs the event regardless of the in-memory state of pendingPermissions.
        // TER-338: dual-broadcast to observer channel when applicable.
        //
        // TER-340: each broadcast is wrapped in its own try/catch — a single failing
        // broadcast (e.g. observer resolver throws) must NOT interrupt the loop and
        // prevent the remaining pendings from being restored. The frontend has DB
        // rehydration as primary path now (TER-340 fix B), but we keep the
        // re-broadcast as reinforcement so subscribers see the live event too.
        try {
          await broadcastToChannelAndObservers(channelId, {
            type: "tool_permission_request",
            requestId: approval.requestId,
            toolName: approval.toolName,
            appId: approval.appId,
            // PERMW-REQ-2: same card fields as the live broadcast.
            mcaId: approval.mcaId,
            irreversible: approval.irreversible,
            input: approval.input,
            messageId: approval.messageId,
            toolCallId: approval.toolCallId,
            timestamp: Date.now(),
            restored: true,
          })
          restoredCount++
        } catch (err) {
          console.error(
            `[PermissionManager] Failed to re-broadcast restored permission ${approval.requestId} — continuing with remaining pendings`,
            { channelId, requestId: approval.requestId, err },
          )
        }
      }

      // Notify channel that external action is requested (only if at least one was restored)
      if (restoredCount > 0) {
        notifyExternalActionChange(channelId, true)
      }

      // Emit user-scoped event for restored permissions so the navbar indicator updates
      try {
        if (db) {
          const channel = await db.collection("channels").findOne({ channelId })
          if (channel?.userId) {
            emitUserPendingPermissionsChanged(channel.userId)
          }
        }
      } catch {
        /* ignore lookup errors */
      }

      return restoredCount
    },

    /**
     * Formerly swept ALL channels every 5 minutes and expired
     * `pending_permission` rows older than a 10-minute TTL (orphans of dead
     * v1 turns, 2026-10-10). PERMB-REQ-2: a v4 pending request carries no
     * turn and never expires by age — it lives until the user decides or an
     * explicit cancellation resolves it. Kept as a no-op so the bootstrap
     * wiring stays unchanged.
     * @spec PERMB-REQ-2
     */
    startOrphanedPermissionSweeper(): void {
      // Intentionally a no-op: pending requests never expire by age.
    },
  }
}

export type PermissionManager = ReturnType<typeof createPermissionManager>
