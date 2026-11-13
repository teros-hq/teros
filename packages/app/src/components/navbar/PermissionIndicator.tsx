/**
 * PermissionIndicator — the amber "N pending approvals" banner of the OS
 * prototype (`.appr-btn`), with the decision sheet behind it.
 *
 * Reads the shared usePendingPermissions hook (same source of truth as
 * PendingApprovalsWindow). Hidden while nothing is pending. Pressing the
 * banner opens the sheet: the pending requests grouped by conversation (agent
 * avatar and name, conversation name, "open the chat"), each drawn as the
 * tool's own card with its detail and its ControlsBar, and Deny all / Allow
 * all under a group of two or more (PERMW-REQ-1, PERMW-REQ-3). The footer
 * opens the full Pending Approvals window.
 *
 * Terminals that need the person (Claude Code blocked on a question, in any
 * workspace they can write in — useTerminalNeeds) are notices here too: they
 * add to the count and head the sheet as the chat's needs-you card.
 */

import React, { useCallback, useState } from "react"
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native"
import { useTranslation } from "react-i18next"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { usePendingPermissions } from "../../hooks/usePendingPermissions"
import { usePendingPermissionCallbacks } from "../../hooks/usePendingPermissionCallbacks"
import { Avatar } from "../Avatar"
import { PermissionContext } from "../mca/types"
import { PendingPermissionCards } from "../permissions/PendingPermissionCards"
import { TerminalNeedCard } from "../needsYou/TerminalNeedCard"
import { terminalNeedKey } from "../needsYou/terminalNeeds"
import { useTerminalNeeds } from "../needsYou/useTerminalNeeds"
import { useColors } from "../mca/primitives/useColors"
import { FONT_MONO, FONT_SANS, FONT_SERIF } from "../mca/primitives/fonts"
import { Btn, IconBtn, Ph, T } from "../ui/ds"
import { fx } from "../../styles/fx"

interface PermissionIndicatorProps {
  /** Rail (collapsed sidebar) — a round amber shield with the count. */
  collapsed?: boolean
}

/** @spec PERMW-REQ-1 */
export function PermissionIndicator({ collapsed = false }: PermissionIndicatorProps) {
  const { t } = useTranslation()
  const { pendingPermissions, groupedArray, handleApprove, handleDeny } = usePendingPermissions()
  const permissionCallbacks = usePendingPermissionCallbacks({ handleApprove, handleDeny })
  const [open, setOpen] = useState(false)
  const { openWindow } = useTilingStore()
  const c = useColors()
  const terminalNeeds = useTerminalNeeds()

  const count = pendingPermissions.length + terminalNeeds.length
  // Only approvals: the banner keeps saying so; with terminals it counts notices.
  const label = terminalNeeds.length
    ? t("nav.pendingNotices", { count })
    : t("nav.pendingApprovals", { count })

  const handleNavigate = useCallback(
    (channelId: string, agentName?: string) => {
      setOpen(false)
      openWindow("chat", {
        channelId,
        agentName,
        workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
      })
    },
    [openWindow],
  )

  const openAll = useCallback(() => {
    setOpen(false)
    openWindow("pending-approvals", {
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
    })
  }, [openWindow])

  // Hide completely when there are no pending permissions.
  // Must be placed AFTER all hooks to respect React's Rules of Hooks.
  if (count === 0) return null

  const sheet = open ? (
    <Modal transparent animationType="fade" visible={open} onRequestClose={() => setOpen(false)}>
      <Pressable style={styles.scrim} onPress={() => setOpen(false)}>
        <Pressable
          {...fx("modal")}
          style={[
            styles.sheet,
            { backgroundColor: c.bgStep },
            Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : null,
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.sheetHead}>
            <View style={{ flex: 1, gap: 4 }}>
              <T step="xs" tone="accent">
                {label}
              </T>
              <Text style={[styles.sheetTitle, { color: c.text }]}>
                {terminalNeeds.length
                  ? t("permissions.waitTitleAny")
                  : t("permissions.waitTitle")}
              </Text>
            </View>
            <IconBtn icon="x" plain sm onPress={() => setOpen(false)} />
          </View>

          <PermissionContext.Provider value={permissionCallbacks}>
            <ScrollView
              style={styles.sheetScroll}
              contentContainerStyle={{ gap: 12, paddingHorizontal: 20, paddingBottom: 16 }}
            >
              {terminalNeeds.length ? (
                <View testID="notices-terminals" style={[styles.group, { backgroundColor: c.nest }]}>
                  <View style={styles.groupHead}>
                    <Ph name="terminal" size={14} color={c.accent} />
                    <Text style={[styles.groupName, { color: c.text }]} numberOfLines={1}>
                      {t("terminal.notices.title", { defaultValue: "Terminals" })}
                    </Text>
                    <Text style={[styles.groupMeta, { color: c.text3 }]}>{terminalNeeds.length}</Text>
                  </View>
                  {terminalNeeds.map((need) => (
                    <TerminalNeedCard
                      key={terminalNeedKey(need)}
                      need={need}
                      onOpen={() => setOpen(false)}
                    />
                  ))}
                </View>
              ) : null}

              {groupedArray.map((group) => (
                <View
                  key={group.channelId}
                  testID={`sheet-group-${group.channelId}`}
                  style={[styles.group, { backgroundColor: c.nest }]}
                >
                  <View style={styles.groupHead}>
                    <Avatar
                      name={group.agentName || t("conversation.agent")}
                      imageUrl={group.agentAvatarUrl}
                      size={24}
                      isAgent
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[styles.groupName, { color: c.text }]} numberOfLines={1}>
                        {group.channelName || t("conversation.newChat")}
                      </Text>
                      <Text style={[styles.groupMeta, { color: c.text3 }]} numberOfLines={1}>
                        {group.agentName || t("conversation.agent")}
                      </Text>
                    </View>
                    <Text style={[styles.groupMeta, { color: c.text3 }]}>
                      {group.permissions.length}
                    </Text>
                    <IconBtn
                      icon="arrow-up-right"
                      plain
                      sm
                      onPress={() => handleNavigate(group.channelId, group.agentName)}
                      title={t("permissions.openChat")}
                      accessibilityLabel={t("permissions.openChat")}
                    />
                  </View>

                  <PendingPermissionCards permissions={group.permissions} />
                </View>
              ))}
            </ScrollView>
          </PermissionContext.Provider>

          <View style={[styles.sheetFoot, { borderTopColor: c.border }]}>
            <View style={{ flex: 1 }} />
            <Btn variant="ghost" size="sm" iconRight="arrow-right" onPress={openAll}>
              {t("nav.viewAll")}
            </Btn>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  ) : null

  if (collapsed) {
    return (
      <>
        <TouchableOpacity
          style={[styles.railBtn, { backgroundColor: c.tint.a.bg, borderColor: c.tint.a.bd }]}
          onPress={() => setOpen(true)}
          accessibilityLabel={label}
        >
          <Ph name="shield-warning" size={16} color={c.tint.a.tx} />
          <View style={[styles.railBadge, { backgroundColor: c.accent }]}>
            <Text style={styles.railBadgeText}>{count > 9 ? "9+" : count}</Text>
          </View>
        </TouchableOpacity>
        {sheet}
      </>
    )
  }

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        {...fx("sheen")}
        style={({ hovered, pressed }: any) => [
          styles.banner,
          { backgroundColor: c.tint.a.bg, borderColor: c.tint.a.bd },
          Platform.OS === "web"
            ? ({
                cursor: "pointer",
                transition: "transform 0.3s cubic-bezier(.16,1,.3,1), box-shadow 0.3s",
                transform: hovered && !pressed ? "translateY(-1px)" : undefined,
                boxShadow: hovered ? "0 8px 20px -10px rgba(245,158,11,0.6)" : "none",
              } as any)
            : null,
        ]}
      >
        <Ph name="shield-warning" size={16} color={c.tint.a.tx} />
        <Text style={[styles.bannerText, { color: c.tint.a.tx }]} numberOfLines={1}>
          {label}
        </Text>
        <View style={{ flex: 1 }} />
        <Ph name="caret-right" size={14} color={c.tint.a.tx} />
      </Pressable>
      {sheet}
    </>
  )
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 38,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    overflow: "hidden",
  },
  bannerText: {
    fontFamily: FONT_SANS,
    fontSize: 13,
    flexShrink: 1,
  },
  railBtn: {
    width: 40,
    height: 40,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  railBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  railBadgeText: { color: "#FFFFFF", fontFamily: FONT_MONO, fontSize: 9, lineHeight: 12 },

  scrim: {
    flex: 1,
    backgroundColor: "rgba(32,28,39,0.35)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  sheet: {
    width: 560,
    maxWidth: "100%",
    maxHeight: "90%",
    borderRadius: 24,
    overflow: "hidden",
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
    paddingTop: 22,
    paddingHorizontal: 24,
    paddingBottom: 14,
  },
  sheetTitle: { fontFamily: FONT_SERIF, fontSize: 24, lineHeight: 28 },
  sheetScroll: { maxHeight: 460 },
  sheetFoot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
  },
  group: { borderRadius: 16, padding: 10, gap: 10 },
  groupHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 },
  groupName: { flex: 1, fontFamily: FONT_SANS, fontSize: 13 },
  groupMeta: { fontFamily: FONT_MONO, fontSize: 10 },
})
