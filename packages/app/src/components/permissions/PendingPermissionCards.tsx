/**
 * PendingPermissionCards — one conversation's pending requests, drawn as the
 * tools' own cards (PERMW-REQ-1).
 *
 * Shared by the navbar sheet (`PermissionIndicator`) and the Pending approvals
 * window. Each request becomes the `ToolCall` the chat would render (status
 * `pending_permission`, `permissionRequestId`, `appId`, `mcaId`,
 * `irreversible`, `input`) and goes through `ToolCallBlock`: registry renderer,
 * `withPermissionSupport`, `PermissionDetail`, `ControlsBar`. Everything comes
 * from the request event — no channel messages are fetched (PERMW-NFR-1).
 *
 * Two or more requests get the batch footer (*Deny all* / *Allow all*) under
 * the cards (PERMW-REQ-3); one request gets no footer.
 *
 * Must sit inside a `PermissionContext.Provider` (see
 * `usePendingPermissionCallbacks`).
 */

import { View } from "react-native"
import type { PendingPermission } from "../../hooks/usePendingPermissions"
import { ToolCallBlock } from "../chat/bubbles/ToolCallBlock"
import type { ToolCall } from "../chat/bubbles/types"
import { PermissionGroupFooter } from "../mca/primitives/GroupedPermissionPanel"

/**
 * The `ToolCall` the tool's renderer takes, built from a pending request.
 *
 * @spec PERMW-REQ-1
 */
export function pendingPermissionToToolCall(perm: PendingPermission): ToolCall {
  return {
    toolCallId: perm.toolCallId ?? perm.requestId,
    toolName: perm.toolName,
    mcaId: perm.mcaId,
    appId: perm.appId,
    input: perm.input,
    status: "pending_permission",
    permissionRequestId: perm.requestId,
    irreversible: perm.irreversible,
  }
}

/** @spec PERMW-REQ-1 */
export function PendingPermissionCards({ permissions }: { permissions: PendingPermission[] }) {
  return (
    <View style={{ gap: 12 }}>
      {permissions.map((perm) => (
        <View key={perm.requestId} testID={`pending-card-${perm.requestId}`}>
          <ToolCallBlock tool={pendingPermissionToToolCall(perm)} />
        </View>
      ))}
      {permissions.length >= 2 ? (
        <PermissionGroupFooter
          tools={permissions.map((perm) => ({
            requestId: perm.requestId,
            irreversible: perm.irreversible === true,
          }))}
        />
      ) : null}
    </View>
  )
}
