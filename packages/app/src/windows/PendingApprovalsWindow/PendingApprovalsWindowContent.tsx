/**
 * PendingApprovalsWindow — every pending permission, grouped by conversation.
 *
 * Features:
 * - List of all pending permissions grouped by conversation
 * - Each request drawn as the tool's own card (detail + ControlsBar), the same
 *   widget as the chat (PERMW-REQ-1); Deny all / Allow all under a group of
 *   two or more (PERMW-REQ-3)
 * - Real-time updates
 *
 * Now uses the shared usePendingPermissions hook (same source of truth
 * as the navbar PermissionIndicator dropdown).
 *
 * Look: the OS prototype's "Esperan tu permiso." page — one Card per
 * conversation (Avatar, serif title, agent · time, mint "Open chat" pill),
 * the tools' own cards under it.
 *
 * Terminals waiting for an answer (useTerminalNeeds, every workspace the
 * person can write in) come first, as the chat's needs-you card.
 */

import React from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import type { PendingApprovalsWindowProps } from "./definition"
import { AppSpinner } from "../../components/ui"
import { Avatar } from "../../components/Avatar"
import { useColors } from "../../components/mca/primitives/useColors"
import { usePendingPermissions } from "../../hooks/usePendingPermissions"
import { usePendingPermissionCallbacks } from "../../hooks/usePendingPermissionCallbacks"
import { PermissionContext } from "../../components/mca/types"
import { PendingPermissionCards } from "../../components/permissions/PendingPermissionCards"
import { TerminalNeedCard } from "../../components/needsYou/TerminalNeedCard"
import { terminalNeedKey } from "../../components/needsYou/terminalNeeds"
import { useTerminalNeeds } from "../../components/needsYou/useTerminalNeeds"
import { getDateLocale } from "../../i18n"
import { Btn, Card, EmptyState, Page, PageHead, Ph, T } from "../../components/ui/ds"

/** @spec PERMW-REQ-1 */
export function PendingApprovalsWindowContent({
  windowId,
}: PendingApprovalsWindowProps & { windowId: string }) {
  const { t } = useTranslation()
  const c = useColors()

  const {
    pendingPermissions,
    groupedArray,
    isLoading,
    handleApprove,
    handleDeny,
  } = usePendingPermissions()
  const permissionCallbacks = usePendingPermissionCallbacks({ handleApprove, handleDeny })
  const terminalNeeds = useTerminalNeeds()

  const { openWindow, findWindow, focusWindow } = useTilingStore()

  const handleOpenChat = (channelId: string, agentName?: string) => {
    const existingWindow = findWindow("chat", (props) => props.channelId === channelId)

    if (existingWindow) {
      focusWindow(existingWindow.id)
    } else {
      openWindow(
        "chat",
        {
          channelId,
          agentName,
          workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
        },
        false,
        windowId,
      )
    }
  }

  const formatTime = (ts?: number): string => {
    if (!ts) return ""
    const d = new Date(ts)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    return sameDay
      ? d.toLocaleTimeString(getDateLocale(), { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(getDateLocale(), {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
  }

  const convCount = groupedArray.length
  const toolCount = pendingPermissions.length
  // Terminals waiting but no approvals: no empty state under them.
  const onlyTerminals = toolCount === 0 && terminalNeeds.length > 0

  const lead = t("pendingApprovals.lead")

  return (
    <Page>
      <PageHead
        eyebrow={t("windows.pendingApprovals")}
        title={t("pendingApprovals.headline")}
        accent={t("pendingApprovals.headlineAccent")}
        lead={lead}
      />

      {terminalNeeds.length ? (
        <Card pad={20} testID="approvals-terminals" style={{ marginBottom: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            <Ph name="terminal" size={22} color={c.accent} />
            <View style={{ flex: 1, minWidth: 160 }}>
              <T step="xl" ellipsis>
                {t("terminal.notices.title", { defaultValue: "Terminals" })}
              </T>
              <T step="sm" tone="text3">
                {t("terminal.notices.lead", {
                  defaultValue:
                    "An agent is waiting for you in a terminal. Answer here, or open the terminal floating or in its tab.",
                })}
              </T>
            </View>
          </View>
          <View style={{ gap: 4, marginTop: 10 }}>
            {terminalNeeds.map((need) => (
              <TerminalNeedCard key={terminalNeedKey(need)} need={need} />
            ))}
          </View>
        </Card>
      ) : null}

      {isLoading && !terminalNeeds.length ? (
        <View style={{ alignItems: "center", paddingVertical: 48, gap: 12 }}>
          <AppSpinner variant="warning" />
          <T step="sm" tone="text3">
            {t("pendingApprovals.loading")}
          </T>
        </View>
      ) : onlyTerminals ? null : pendingPermissions.length === 0 ? (
        <Card pad={8}>
          <EmptyState
            icon="shield-check"
            title={t("pendingApprovals.emptyTitle")}
            text={t("pendingApprovals.emptyText")}
          />
        </Card>
      ) : (
        <>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 16,
            }}
          >
            <T step="sm" tone="text2">
              {t("pendingApprovals.summary", { tools: toolCount, convs: convCount })}
            </T>
            <T step="sm" tone="text3">
              {t("pendingApprovals.hint")}
            </T>
          </View>

          <PermissionContext.Provider value={permissionCallbacks}>
            <View style={{ gap: 16 }}>
              {groupedArray.map((group) => {
                const latest = group.permissions.reduce((m, p) => Math.max(m, p.timestamp ?? 0), 0)
                return (
                  // The testID sits on a wrapper: a non-interactive Card drops it.
                  <View key={group.channelId} testID={`approvals-group-${group.channelId}`}>
                    <Card pad={20}>
                      {/* Conversation header */}
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 14,
                          flexWrap: "wrap",
                        }}
                      >
                        <Avatar
                          name={group.agentName || t("conversation.agent")}
                          imageUrl={group.agentAvatarUrl}
                          size={40}
                          isAgent
                        />
                        <View style={{ flex: 1, minWidth: 160 }}>
                          <T step="xl" ellipsis>
                            {group.channelName || t("conversation.newChat")}
                          </T>
                          <T step="sm" tone="text3" ellipsis>
                            {group.agentName || t("conversation.agent")}
                            {latest ? ` · ${formatTime(latest)}` : ""}
                            {` · ${t("pendingApprovals.toolCount", { count: group.permissions.length })}`}
                          </T>
                        </View>
                        <Btn
                          variant="mint"
                          icon="chat-circle"
                          onPress={() => handleOpenChat(group.channelId, group.agentName)}
                        >
                          {t("pendingApprovals.openChat")}
                        </Btn>
                      </View>

                      {/* The tools' own cards, with Deny all / Allow all under two or more
                          (PERMW-REQ-1, PERMW-REQ-3). */}
                      <View style={{ marginTop: 16 }}>
                        <PendingPermissionCards permissions={group.permissions} />
                      </View>
                    </Card>
                  </View>
                )
              })}
            </View>
          </PermissionContext.Provider>
        </>
      )}
    </Page>
  )
}
