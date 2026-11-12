/**
 * usePendingPermissionCallbacks — the `PermissionContext` value for the
 * surfaces that decide permissions outside a chat: the navbar sheet
 * (`PermissionIndicator`) and the Pending approvals window.
 *
 * The same four callbacks the chat uses (`useChatPermissions`), on the same
 * client calls: `respondToToolPermission` for the decision and
 * `app.updateToolPermission` for the "always" rule. The decision itself goes
 * through `usePendingPermissions`' handlers, which also drop the request from
 * the local list. No channel subscription of its own: the pending list already
 * subscribes to every channel with a pending request.
 */

import { useCallback, useMemo } from "react"
import type { PermissionContextValue } from "../components/mca/types"
import { getTerosClient } from "../services/terosClientSingleton"

export interface PendingPermissionHandlers {
  /** Grants one request and removes it from the pending list. */
  handleApprove: (requestId: string) => void
  /** Denies one request and removes it from the pending list. */
  handleDeny: (requestId: string) => void
}

/** @spec PERMW-REQ-1 */
export function usePendingPermissionCallbacks({
  handleApprove,
  handleDeny,
}: PendingPermissionHandlers): PermissionContextValue {
  const client = getTerosClient()

  const onGrant = handleApprove
  const onDeny = handleDeny

  const onGrantAlways = useCallback(
    async (requestId: string, appId: string, toolName: string) => {
      handleApprove(requestId)
      try {
        await client.app.updateToolPermission(appId, toolName, "allow")
      } catch (err) {
        console.error("🔐 Failed to update tool permission:", err)
      }
    },
    [client, handleApprove],
  )

  const onDenyAlways = useCallback(
    async (requestId: string, appId: string, toolName: string) => {
      handleDeny(requestId)
      try {
        await client.app.updateToolPermission(appId, toolName, "forbid")
      } catch (err) {
        console.error("🔐 Failed to update tool permission:", err)
      }
    },
    [client, handleDeny],
  )

  return useMemo<PermissionContextValue>(
    () => ({ onGrant, onGrantAlways, onDeny, onDenyAlways }),
    [onGrant, onGrantAlways, onDeny, onDenyAlways],
  )
}
