/**
 * useChatPermissions
 *
 * Manages tool permission requests:
 * - Listens for tool_permission_request events
 * - Tracks pending permissions
 * - Provides grant/deny callbacks
 * - Builds PermissionContextValue
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import { getTerosClient } from "../../../app/_layout"
import { useChatStore } from "../../store/chatStore"
import type { Message, ToolCall } from "../../components/MessageBubble"
import type { PermissionContextValue } from "../../components/mca"
import { usePermissionSound } from "../usePermissionSound"

// ============================================
// HOOK
// ============================================

export function useChatPermissions(channelId: string | undefined): PermissionContextValue {
  const client = getTerosClient()
  const { playPermissionSound } = usePermissionSound()

  // Track pending permission requests: requestId -> {messageId, toolCallId, appId, toolName}
  const pendingPermissions = useRef<
    Map<string, { messageId: string; toolCallId: string; appId: string; toolName: string }>
  >(new Map())

  // ----------------------------------------
  // EFFECT: Tool Permission Requests
  // ----------------------------------------
  useEffect(() => {
    const handlePermissionRequest = (data: any) => {
      console.log("🔐 Tool permission request received:", data)
      // Play notification sound so the user knows action is required
      playPermissionSound()
      const { requestId, toolName, appId, messageId, toolCallId, input, restored } = data

      if (messageId && toolCallId) {
        pendingPermissions.current.set(requestId, { messageId, toolCallId, appId, toolName })

        const store = useChatStore.getState()
        const existingMessage = store.messages[messageId]

        if (existingMessage) {
          store.updateToolCall(messageId, toolCallId, {
            status: "pending_permission",
            appId,
            permissionRequestId: requestId,
          })
        } else if (restored && channelId) {
          console.log("🔐 Creating message for restored permission request:", messageId)

          const toolCall: ToolCall = {
            toolCallId,
            toolName,
            input,
            status: "pending_permission",
            appId,
            permissionRequestId: requestId,
          }

          store.addToolCall(messageId, channelId, toolCall)
        } else {
          store.updateToolCall(messageId, toolCallId, {
            status: "pending_permission",
            appId,
            permissionRequestId: requestId,
          })
        }
      } else {
        console.error("🔐 BUG: Permission request missing messageId or toolCallId!", data)
        client.respondToToolPermission(requestId, true)

        if (channelId) {
          const errorMessage: Message = {
            id: `error-perm-${Date.now()}`,
            channelId,
            content: {
              type: "error",
              errorType: "unknown",
              userMessage: `Permiso auto-aceptado para "${toolName}" (bug: falta contexto)`,
              technicalMessage: `tool_permission_request sin messageId/toolCallId. requestId: ${requestId}, appId: ${appId}`,
            },
            sender: "system",
            timestamp: new Date(),
          }
          useChatStore.getState().upsertMessage(errorMessage)
        }
      }
    }

    client.on("tool_permission_request", handlePermissionRequest)
    return () => {
      client.off("tool_permission_request", handlePermissionRequest)
    }
  }, [client, channelId, playPermissionSound])

  // ----------------------------------------
  // Callbacks
  // ----------------------------------------

  const onGrant = useCallback(
    (requestId: string) => {
      console.log("🔐 Permission granted:", requestId)
      client.respondToToolPermission(requestId, true)

      const pending = pendingPermissions.current.get(requestId)
      if (pending) {
        useChatStore.getState().updateToolCall(pending.messageId, pending.toolCallId, {
          status: "running",
          permissionRequestId: undefined,
        })
        pendingPermissions.current.delete(requestId)
      }
    },
    [client],
  )

  const onGrantAlways = useCallback(
    async (requestId: string, appId: string, toolName: string) => {
      console.log("🔐 Permission granted always:", requestId, appId, toolName)

      client.respondToToolPermission(requestId, true)

      const pending = pendingPermissions.current.get(requestId)
      if (pending) {
        useChatStore.getState().updateToolCall(pending.messageId, pending.toolCallId, {
          status: "running",
          permissionRequestId: undefined,
        })
        pendingPermissions.current.delete(requestId)
      }

      try {
        await client.app.updateToolPermission(appId, toolName, "allow")
        console.log("🔐 Tool permission updated to allow:", toolName)
      } catch (err) {
        console.error("🔐 Failed to update tool permission:", err)
      }
    },
    [client],
  )

  const onDeny = useCallback(
    (requestId: string) => {
      console.log("🔐 Permission denied:", requestId)
      client.respondToToolPermission(requestId, false)

      const pending = pendingPermissions.current.get(requestId)
      if (pending) {
        useChatStore.getState().updateToolCall(pending.messageId, pending.toolCallId, {
          status: "failed",
          error: "Permiso denegado por el usuario",
          permissionRequestId: undefined,
        })
        pendingPermissions.current.delete(requestId)
      }
    },
    [client],
  )

  const onDenyAlways = useCallback(
    async (requestId: string, appId: string, toolName: string) => {
      console.log("🔐 Permission denied always:", requestId, appId, toolName)

      client.respondToToolPermission(requestId, false)

      const pending = pendingPermissions.current.get(requestId)
      if (pending) {
        useChatStore.getState().updateToolCall(pending.messageId, pending.toolCallId, {
          status: "failed",
          error: "Permiso denegado permanentemente",
          permissionRequestId: undefined,
        })
        pendingPermissions.current.delete(requestId)
      }

      try {
        await client.app.updateToolPermission(appId, toolName, "forbid")
        console.log("🔐 Tool permission updated to deny:", toolName)
      } catch (err) {
        console.error("🔐 Failed to update tool permission:", err)
      }
    },
    [client],
  )

  // ----------------------------------------
  // Memoized context value
  // ----------------------------------------
  const permissionContextValue = useMemo<PermissionContextValue>(
    () => ({ onGrant, onGrantAlways, onDeny, onDenyAlways }),
    [onGrant, onGrantAlways, onDeny, onDenyAlways],
  )

  return permissionContextValue
}
