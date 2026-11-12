/**
 * Grouped permission frame — PERMW-REQ-3 (supersedes the PERMB-REQ-4 rows).
 *
 * A batch is a FRAME around the tools' own cards, not a panel of its own rows:
 *
 *   🛡  3 actions need your approval            ← PermissionGroupHeader
 *       (1 destructive — decide individually)      (before the first pending card)
 *   ┌ card ─────────────────────────────┐
 *   │ HubSpot · Create a new contact     │
 *   └────────────────────────────────────┘
 *   [Always deny] [Deny] [Always allow] [Allow]   ← every card keeps its bar
 *   … more cards …
 *                       Deny all  [Allow all]   ← PermissionGroupFooter
 *                                                  (after the last card)
 *
 * The chat renders both around a run of ≥2 pending requests (as
 * `groupPendingPermissions` defines the run). The navbar sheet and the Pending
 * approvals window render the footer under a conversation group with ≥2
 * pending requests. One pending request shows neither.
 *
 *   • Allow all → grants every REVERSIBLE request; irreversible ones stay
 *     pending and are decided on their own card (fail-closed). Hidden when all
 *     are destructive.
 *   • Deny all → denies every request of the batch.
 *   Both confirm first, apply to this batch only and never persist a rule.
 *
 * Iterates the per-request callbacks from `PermissionContext` — no batch backend
 * endpoint needed.
 */

import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { XStack, YStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import {
  requestIdsForAllowAll,
  requestIdsForDenyAll,
} from "../../../hooks/chat/permission-grouping"
import { captureMessage } from "../../../lib/sentry"
import { usePermissionCallbacks } from "../types"
import { ConfirmDialog } from "./ConfirmDialog"
import { ShieldCheck } from "./icons"
import { PillBtn } from "./Pill"
import { useColors } from "./useColors"

/** Minimal shape the frame needs — structurally compatible with `GroupedTool`. */
export interface GroupedPermissionTool {
  requestId: string
  irreversible: boolean
}

export interface GroupedPermissionFrameProps {
  tools: GroupedPermissionTool[]
}

/**
 * "N actions need your approval", with the destructive note when applicable.
 * Rendered before the first pending card of the run.
 *
 * @spec PERMW-REQ-3
 */
export function PermissionGroupHeader({ tools }: GroupedPermissionFrameProps) {
  const c = useColors()
  const { t } = useTranslation()
  const destructiveCount = useMemo(() => tools.filter((tool) => tool.irreversible).length, [tools])
  const hasReversible = destructiveCount < tools.length

  const subLabel = !hasReversible
    ? t("mca.permissionGroup.allDestructiveNote")
    : destructiveCount > 0
      ? t("mca.permissionGroup.destructiveNote", { count: destructiveCount })
      : undefined

  return (
    <XStack
      paddingVertical={6}
      paddingHorizontal={4}
      alignItems="center"
      gap={10}
      testID="permission-group-header"
    >
      <ShieldCheck size={16} color={c.accent} />
      <YStack flex={1} minWidth={0} gap={1}>
        <T step="sm" numberOfLines={1} ellipsizeMode="tail" style={{ fontSize: 14, lineHeight: 20 }}>
          {t("mca.permissionGroup.awaiting", { count: tools.length })}
        </T>
        {subLabel && (
          <T step="12" color={c.tint.r.tx} numberOfLines={1} ellipsizeMode="tail">
            {subLabel}
          </T>
        )}
      </YStack>
    </XStack>
  )
}

type BulkAction = "denyAll" | "allowAll"

/**
 * *Deny all* / *Allow all* for the batch, behind the confirmation dialog.
 * Rendered after the last card of the run (chat) or under a conversation
 * group's cards (navbar sheet, Pending approvals window).
 *
 * @spec PERMW-REQ-3
 */
export function PermissionGroupFooter({ tools }: GroupedPermissionFrameProps) {
  const { t } = useTranslation()
  const callbacks = usePermissionCallbacks()
  const [confirmAction, setConfirmAction] = useState<BulkAction | null>(null)
  const hasReversible = tools.some((tool) => !tool.irreversible)

  if (!callbacks) {
    const message =
      `[PermissionGroupFooter] PermissionContext is null for a batch of ${tools.length} ` +
      "requests. The footer requires the PermissionContext provider — ChatView, the " +
      "navbar sheet or the Pending approvals window. Permission UI will not render."
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      throw new Error(message)
    }
    captureMessage(message, "error", { source: "PermissionGroupFooter", count: tools.length })
    return null
  }

  const execute = (action: BulkAction) => {
    if (action === "allowAll") {
      for (const requestId of requestIdsForAllowAll(tools)) callbacks.onGrant(requestId)
    } else {
      for (const requestId of requestIdsForDenyAll(tools)) callbacks.onDeny(requestId)
    }
  }

  return (
    <YStack testID="permission-group-footer">
      <XStack
        paddingTop={8}
        paddingHorizontal={4}
        alignItems="center"
        justifyContent="flex-end"
        gap={8}
        flexWrap="wrap"
      >
        <PillBtn
          variant="ghost"
          label={t("mca.permissionGroup.denyAll")}
          onPress={() => setConfirmAction("denyAll")}
          testID="permission-group-deny-all"
        />
        {hasReversible && (
          <PillBtn
            variant="sec"
            icon={ShieldCheck}
            label={t("mca.permissionGroup.allowAll")}
            onPress={() => setConfirmAction("allowAll")}
            testID="permission-group-allow-all"
          />
        )}
      </XStack>

      <ConfirmDialog
        visible={confirmAction !== null}
        title={t("mca.permission.confirmTitle")}
        message={
          confirmAction === "denyAll"
            ? t("mca.permission.confirmDenyAll")
            : confirmAction === "allowAll"
              ? t("mca.permission.confirmAllowAll")
              : ""
        }
        variant={confirmAction === "denyAll" ? "deny" : "allow"}
        onConfirm={() => {
          if (confirmAction) execute(confirmAction)
          setConfirmAction(null)
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </YStack>
  )
}
