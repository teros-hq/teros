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

// Pending permission requests (requestId -> resolver)
export interface PendingPermission {
  resolve: (granted: boolean) => void
  reject: (error: Error) => void
  toolName: string
  appId: string
  input: Record<string, any>
  channelId: string
  /** Message ID containing the tool call */
  messageId?: string
  /** Tool call ID within the message */
  toolCallId?: string
  /** Whether this is a restored permission (from page reload) */
  restored?: boolean
}

/**
 * Context for the current tool call (used to link permission UI to the tool)
 */
export interface ToolCallContext {
  messageId: string
  toolCallId: string
}

/**
 * Callbacks for tool status updates during permission flow
 */
export interface PermissionStatusCallbacks {
  /** Called when tool enters pending_permission state */
  onPendingPermission?: (
    permissionRequestId: string,
    appId: string,
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

// Global state for pending permissions (in-memory)
const pendingPermissions = new Map<string, PendingPermission>()

// Generate unique request ID
let permissionRequestCounter = 0
function generatePermissionRequestId(): string {
  return `perm_${Date.now()}_${++permissionRequestCounter}`
}

export interface PermissionManagerDeps {
  broadcastToChannel: (channelId: string, message: any) => void
  onExternalActionChange?: (channelId: string, requested: boolean) => void
  /** Database for persisting permission state */
  db?: Db
}

/**
 * Creates a permission manager for handling tool permission requests
 */
export function createPermissionManager(deps: PermissionManagerDeps) {
  const { broadcastToChannel, onExternalActionChange, db } = deps

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
   * Check if there are still pending permissions for a channel
   */
  function hasOtherPendingInChannel(channelId: string, excludeRequestId?: string): boolean {
    return Array.from(pendingPermissions.entries()).some(
      ([reqId, p]) => p.channelId === channelId && reqId !== excludeRequestId,
    )
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
      getToolCallContext?: (toolCallId?: string) => ToolCallContext | null,
      statusCallbacks?: PermissionStatusCallbacks,
    ) {
      return async (
        toolName: string,
        appId: string,
        input: Record<string, any>,
        toolCallId?: string,
      ): Promise<boolean> => {
        return new Promise((resolve, reject) => {
          const requestId = generatePermissionRequestId()

          // Get tool call context for linking UI to the tool
          // Pass toolCallId so we can look up the correct context for concurrent tools
          const context = getToolCallContext?.(toolCallId)

          // Update tool status to pending_permission (with requestId and appId for reload recovery)
          // Pass toolCallId from context for concurrent tool tracking
          statusCallbacks
            ?.onPendingPermission?.(requestId, appId, context?.toolCallId)
            .catch((err) => {
              console.error("[PermissionManager] Error calling onPendingPermission:", err)
            })

          // Capture toolCallId for use in the resolve closure
          const capturedToolCallId = context?.toolCallId

          // Store pending request with status callbacks for when permission is resolved
          pendingPermissions.set(requestId, {
            resolve: (granted: boolean) => {
              // If granted, update status to running before resolving
              if (granted && statusCallbacks?.onPermissionGranted) {
                statusCallbacks
                  .onPermissionGranted(capturedToolCallId)
                  .then(() => {
                    resolve(granted)
                  })
                  .catch((err) => {
                    console.error("[PermissionManager] Error calling onPermissionGranted:", err)
                    resolve(granted)
                  })
              } else {
                resolve(granted)
              }
            },
            reject,
            toolName,
            appId,
            input,
            channelId,
            messageId: context?.messageId,
            toolCallId: capturedToolCallId,
          })

          // Send permission request to client with context for inline UI
          broadcastToChannel(channelId, {
            type: "tool_permission_request",
            requestId,
            toolName,
            appId,
            input,
            // Include context so frontend can update the correct tool call
            messageId: context?.messageId,
            toolCallId: context?.toolCallId,
            timestamp: Date.now(),
          })

          // Notify channel that external action is requested
          notifyExternalActionChange(channelId, true)

          console.log(
            `[PermissionManager] Permission request sent: ${requestId} for ${toolName} (msg: ${context?.messageId}, tool: ${context?.toolCallId})`,
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
    ): Promise<void> {
      const pending = pendingPermissions.get(requestId)
      if (!pending) {
        console.warn(`[PermissionManager] No pending permission request found: ${requestId}`)
        return
      }

      // Remove from pending
      pendingPermissions.delete(requestId)

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
        pending.resolve(granted)
      }
    },

    /**
     * Get pending permission count (for debugging)
     */
    getPendingCount(): number {
      return pendingPermissions.size
    },

    /**
     * Clear all pending permissions (for cleanup)
     */
    clearAll(): void {
      for (const [_requestId, pending] of pendingPermissions) {
        if (!pending.restored) {
          pending.resolve(false)
        }
      }
      pendingPermissions.clear()
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

      for (const approval of pendingApprovals) {
        // Check if already registered (avoid duplicates on multiple subscribes)
        if (pendingPermissions.has(approval.requestId)) {
          console.log(
            `[PermissionManager] Request ${approval.requestId} already registered, skipping`,
          )
          continue
        }

        // Register in memory with restored flag
        // The resolve function is a no-op since there's no Promise waiting
        pendingPermissions.set(approval.requestId, {
          resolve: () => {}, // No-op for restored permissions
          reject: () => {},
          toolName: approval.toolName,
          appId: approval.appId,
          input: approval.input,
          channelId,
          messageId: approval.messageId,
          toolCallId: approval.toolCallId,
          restored: true,
        })

        // Send permission request to client
        broadcastToChannel(channelId, {
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
      }

      // Notify channel that external action is requested
      if (pendingApprovals.length > 0) {
        notifyExternalActionChange(channelId, true)
      }

      return pendingApprovals.length
    },
  }
}

export type PermissionManager = ReturnType<typeof createPermissionManager>
