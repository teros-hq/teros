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
 */

import type { Db } from "mongodb"
import { captureException } from "../../lib/sentry"
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
 * Callback to execute a restored tool and update the message
 */
export type RestoredToolExecutor = (params: {
  channelId: string
  messageId: string
  toolCallId: string
  toolName: string
  input: Record<string, any>
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
  } = deps

  // ---------------------------------------------------------------------------
  // In-memory state — encapsulated in a PendingApprovalsRegistry instance.
  // The class owns pending+resolved+userIndex Maps with invariants enforced by
  // its API; we just compose it with broadcasts + DB. Instance-local so
  // multiple PermissionManagers in tests stay isolated.
  // ---------------------------------------------------------------------------

  const registry = new PendingApprovalsRegistry()

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
     */
    createAskPermissionCallback(
      channelId: string,
      userId: string,
      getToolCallContext?: (toolCallId?: string) => ToolCallContext | null,
      statusCallbacks?: PermissionStatusCallbacks,
    ) {
      return async (
        toolName: string,
        appId: string,
        input: Record<string, any>,
        irreversible: boolean,
        toolCallId?: string,
      ): Promise<PermissionResolution> => {
        return new Promise((resolve, reject) => {
          const requestId = generatePermissionRequestId()

          // Get tool call context for linking UI to the tool.
          // Defense: wrap in try/catch — if the lookup throws (e.g. streamState
          // mutated under us, Map iteration error) the promise must not be left hanging.
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
            resolve('denied')
            return
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
            return resolve('denied')
          }

          // Update tool status to pending_permission (with requestId, appId, and
          // irreversible flag for the frontend Irreversibility Indicator). If the
          // status update fails the user would never see a modal — the request would
          // hang unanswered forever. Better to clean up + deny immediately.
          const pendingPromise = statusCallbacks
            ?.onPendingPermission?.(requestId, appId, irreversible, context?.toolCallId)
          if (pendingPromise) {
            pendingPromise.catch((err) => {
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
                stillPending.resolve('denied')
              }
            })
          }

          // Capture toolCallId for use in the resolve closure
          const capturedToolCallId = context?.toolCallId

          // Store pending request. registry.register() also auto-indexes by userId
          // for the navbar indicator (no manual addToUserIndex needed).
          registry.register(requestId, {
            resolve: (resolution: PermissionResolution) => {
              // If granted, update status to running before resolving
              if (resolution === 'granted' && statusCallbacks?.onPermissionGranted) {
                statusCallbacks
                  .onPermissionGranted(capturedToolCallId)
                  .then(() => {
                    resolve(resolution)
                  })
                  .catch((err) => {
                    console.error("[PermissionManager] Error calling onPermissionGranted:", err)
                    resolve(resolution)
                  })
              } else {
                resolve(resolution)
              }
            },
            reject,
            toolName,
            appId,
            input,
            channelId,
            messageId: context?.messageId,
            toolCallId: capturedToolCallId,
            userId,
            irreversible,
            createdAt: Date.now(),
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
            `[PermissionManager] Permission request sent: ${requestId} for ${toolName} (msg: ${context?.messageId}, tool: ${context?.toolCallId}) — waiting for user response`,
          )
        })
      }
    },

    /**
     * Handle permission response from client
     * For restored permissions, executes the tool if granted
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
        `[PermissionManager] Permission ${granted ? "granted" : "denied"} for request: ${requestId} (restored: ${pending.restored})`,
      )

      // Handle restored permissions differently
      if (pending.restored) {
        if (granted && restoredToolExecutor && pending.messageId && pending.toolCallId) {
          // Execute the tool and update the message
          try {
            await restoredToolExecutor({
              channelId: pending.channelId,
              messageId: pending.messageId,
              toolCallId: pending.toolCallId,
              toolName: pending.toolName,
              input: pending.input,
            })
          } catch (error) {
            console.error(`[PermissionManager] Failed to execute restored tool:`, error)
            // Update message to failed
            await updateChannelMessageStatus(pending.messageId, "failed", {
              error: `Error executing tool: ${error instanceof Error ? error.message : String(error)}`,
              permissionRequestId: undefined,
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
        } else if (!granted && pending.messageId) {
          // Update message to failed
          await updateChannelMessageStatus(pending.messageId, "failed", {
            error: "Permission denied by user",
            permissionRequestId: undefined,
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
      } else {
        // Normal flow - resolve the promise
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
        if (!pending.restored) {
          pending.resolve('denied')
        }
      }
      registry.clear()
    },

    /**
     * Find pending permission messages in channel_messages
     * Looks for messages with status 'pending_permission' that have permissionRequestId
     */
    async findPendingApprovals(channelId: string): Promise<
      Array<{
        toolCallId: string
        toolName: string
        appId: string
        requestId: string
        input: any
        messageId: string
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
          requestId: string
          input: any
          messageId: string
        }> = []

        for (const msg of messages) {
          const content = msg.content
          if (content?.permissionRequestId && content?.appId) {
            pendingApprovals.push({
              toolCallId: content.toolCallId,
              toolName: content.toolName,
              appId: content.appId,
              requestId: content.permissionRequestId,
              input: content.input || {},
              messageId: msg.messageId,
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
     * Restore pending permission requests for a channel
     * Called when a user subscribes to a channel
     *
     * This:
     * 1. Finds pending_permission messages in channel_messages
     * 2. Registers them in memory so handleResponse works
     * 3. Sends tool_permission_request to the client
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
            input: approval.input,
            channelId,
            messageId: approval.messageId,
            toolCallId: approval.toolCallId,
            restored: true,
            userId,
            createdAt: Date.now(),
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
  }
}

export type PermissionManager = ReturnType<typeof createPermissionManager>
