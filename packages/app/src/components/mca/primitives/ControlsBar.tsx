/**
 * ControlsBar — Renderer UX Guide v2 §8.
 *
 * Single-line action row that appears immediately BELOW the Tool Call Card when
 * `status === 'pending_permission'`. Layout (OS prototype pills):
 *
 *   [Shield] "Awaiting your approval" (flex:1, ellipsis)
 *   [Always deny · ghost danger] [Deny · sec] [Always allow · sec] [Allow · primary ✓]
 *
 * The same bar sits under the tool's own card on every surface that decides a
 * permission — the chat, the navbar sheet and the Pending approvals window
 * (PERMW-REQ-1). The four pills are always visible; the "always" pair is a rule,
 * so it reads "Always deny / Always allow".
 *
 * "Deny" and "Allow" execute immediately. "Always deny" and "Always allow"
 * show a confirmation dialog before executing, since they permanently change
 * the tool's permission state.
 *
 * The request has no expiry — it waits for the user's decision indefinitely
 * (the server-side auto-deny countdown was removed).
 *
 * The label never wraps (`numberOfLines={1}`); the pill group wraps as a
 * block when the card is narrow so no action ever gets clipped.
 *
 * The bar is rendered directly by `withPermissionSupport` as a sibling of the
 * renderer — NOT dispatched into the card body, and not via
 * PermissionControlsContext. It stays outside the card deliberately: the card is
 * collapsible, and collapsing it must never hide the decision the user has to
 * make. (The approval DETAIL does travel down the context into the card body —
 * that is information, not an action.) Renderers do not import `ControlsBar`
 * directly.
 */

import { Check, Shield, ShieldCheck, ShieldOff, X } from "./icons"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { XStack, YStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { captureMessage } from "../../../lib/sentry"
import { usePermissionCallbacks } from "../types"
import { ConfirmDialog } from "./ConfirmDialog"
import { PillBtn } from "./Pill"
import { useColors } from "./useColors"

export interface ControlsBarProps {
  permissionRequestId: string
  appId?: string
  toolName: string
}

/** @spec PERMW-REQ-1 */
export function ControlsBar({ permissionRequestId, appId, toolName }: ControlsBarProps) {
  const c = useColors()
  const { t } = useTranslation()
  const callbacks = usePermissionCallbacks()
  const [confirmAction, setConfirmAction] = useState<"denyAlways" | "allowAlways" | null>(null)

  // Fail loud when the PermissionContext is missing.
  if (!callbacks) {
    const message =
      `[ControlsBar] PermissionContext is null for tool "${toolName}" ` +
      `(requestId=${permissionRequestId}). The ControlsBar requires the ` +
      `PermissionContext provider mounted higher in the tree — usually ` +
      `via withPermissionSupport HOC. The permission UI will not render.`
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      throw new Error(message)
    }
    captureMessage(message, "error", {
      source: "ControlsBar",
      toolName,
      permissionRequestId,
      appId,
    })
    return null
  }

  const handleDeny = () => callbacks.onDeny(permissionRequestId)
  const handleAllow = () => callbacks.onGrant(permissionRequestId)
  const handleDenyAlways = () => {
    if (appId) callbacks.onDenyAlways(permissionRequestId, appId, toolName)
    else callbacks.onDeny(permissionRequestId)
  }
  const handleAllowAlways = () => {
    if (appId) callbacks.onGrantAlways(permissionRequestId, appId, toolName)
    else callbacks.onGrant(permissionRequestId)
  }

  return (
    <YStack>
      {/* Floating action row — no background, no border. Sits below the card. */}
      <XStack paddingTop={8} paddingHorizontal={4} alignItems="center" gap={10} flexWrap="wrap">
        <XStack flex={1} minWidth={140} alignItems="center" gap={6}>
          <Shield size={13} color={c.text3} />
          <T
            step="12"
            tone="text3"
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{ flex: 1, minWidth: 0 }}
          >
            {t("mca.permission.awaiting")}
          </T>
        </XStack>

        <XStack alignItems="center" gap={6} flexShrink={0} flexWrap="wrap">
          <PillBtn
            variant="ghostDanger"
            icon={ShieldOff}
            label={t("mca.permission.denyAlways")}
            onPress={() => setConfirmAction("denyAlways")}
          />
          <PillBtn
            variant="sec"
            icon={X}
            label={t("mca.permission.deny")}
            onPress={handleDeny}
          />
          <PillBtn
            variant="sec"
            icon={ShieldCheck}
            label={t("mca.permission.allowAlways")}
            onPress={() => setConfirmAction("allowAlways")}
          />
          <PillBtn
            variant="primary"
            icon={Check}
            label={t("mca.permission.allow")}
            onPress={handleAllow}
          />
        </XStack>
      </XStack>

      <ConfirmDialog
        visible={confirmAction !== null}
        title={t("mca.permission.confirmTitle")}
        message={
          confirmAction === "denyAlways"
            ? t("mca.permission.confirmDenyAlways")
            : confirmAction === "allowAlways"
              ? t("mca.permission.confirmAllowAlways")
              : ""
        }
        variant={confirmAction === "denyAlways" ? "deny" : "allow"}
        onConfirm={() => {
          if (confirmAction === "denyAlways") handleDenyAlways()
          else if (confirmAction === "allowAlways") handleAllowAlways()
          setConfirmAction(null)
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </YStack>
  )
}
