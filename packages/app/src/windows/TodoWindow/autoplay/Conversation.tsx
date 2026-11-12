/**
 * The task's linked conversation (TODOAP-REQ-13): the 13 px chat icon that
 * sits right of the assignee avatar in tree and day rows, and the opener that
 * shows the conversation (`chat` window) as a preview tab beside the tree
 * (docs/specs/ui/preview-tabs.md), also used by the detail strip's
 * conversation chip (TODODH-REQ-2).
 */
import React from "react"
import { useTranslation } from "react-i18next"
import { Pressable, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { useTilingStore } from "../../../store/tilingStore"
import { web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"

/**
 * @spec TODOAP-REQ-13 Open the conversation as a preview tab beside
 * `sourceWindowId` (the To Do tree window).
 */
export function openConversation(channelId: string, sourceWindowId?: string): void {
  useTilingStore.getState().openWindow("chat", { channelId }, { preview: true, sourceWindowId })
}

/**
 * @spec TODOAP-REQ-13 From a detail window: the detail tab is pinned (as any
 * action on it does) and the conversation opens beside the To Do tree, so it
 * takes the preview slot without replacing the detail.
 */
export function openConversationFromDetail(channelId: string, detailWindowId?: string): void {
  const tiling = useTilingStore.getState()
  if (detailWindowId) tiling.pinWindow(detailWindowId)
  const detail = detailWindowId ? tiling.windows[detailWindowId] : undefined
  const tree = Object.entries(tiling.windows).find(
    ([, w]) => w.type === "todo" && (!detail || w.desktopIndex === detail.desktopIndex),
  )?.[0]
  openConversation(channelId, tree ?? detailWindowId)
}

/** @spec TODOAP-REQ-13 The row's conversation icon; never selects the row. */
export function ConversationIcon({ channelId, onOpen }: { channelId: string; onOpen: (channelId: string) => void }) {
  const td = useTd()
  const { t } = useTranslation()
  const label = t("todo.conversation.open")
  return (
    <Pressable
      testID="todo-row-conversation"
      accessibilityRole="button"
      accessibilityLabel={label}
      {...({ title: label, tabIndex: -1 } as Record<string, unknown>)}
      onPress={(e: any) => {
        e?.stopPropagation?.()
        onOpen(channelId)
      }}
      hitSlop={6}
      style={({ hovered }: any) => [
        { width: 18, height: 18, marginLeft: -4, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: hovered ? td.controlBg : "transparent" },
        web({ cursor: "pointer", transition: "background .2s" }) as ViewStyle,
      ]}
    >
      {({ hovered }: any) => <Ph name="chat-circle" size={13} color={hovered ? td.text : td.text3} />}
    </Pressable>
  )
}
