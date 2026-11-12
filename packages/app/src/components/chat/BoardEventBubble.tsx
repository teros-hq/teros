// ============================================================================
// BOARD EVENT BUBBLE
//
// Renders messages that come from a board subscription
// (metadata.source === 'board_subscription').
// These are system-level notifications about board activity and should
// be displayed in a compact, visually distinct style — not as regular
// chat bubbles. Styled as the OS prototype's violet-washed system row:
// kanban glyph · "BOARD" codenote · text · time in mono.
// ============================================================================

import React from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { Ph, T } from "../ui/ds"
import { getDateLocale } from "../../i18n"
import type { Message } from "../../store/chatStore"

interface BoardEventBubbleProps {
  message: Message
  showTimestamp?: boolean
}

export function BoardEventBubble({ message, showTimestamp = true }: BoardEventBubbleProps) {
  const { t } = useTranslation()
  const c = useColors()

  const text = message.content.type === "text" ? message.content.text : t("conversation.boardEvent")

  return (
    <View
      style={{
        width: "100%",
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingVertical: 8,
        paddingHorizontal: 12,
        marginVertical: 2,
        borderRadius: 12,
        backgroundColor: c.tint.i.bg,
      }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          backgroundColor: c.tile,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Ph name="kanban" size={13} color={c.accent} />
      </View>

      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <T step="codenote" tone="accent">
            {t("conversation.board")}
          </T>
          {showTimestamp && (
            <T step="codenote" tone="text3">
              {message.timestamp.toLocaleTimeString(getDateLocale(), {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </T>
          )}
        </View>
        <T step="12" tone="text2">
          {text}
        </T>
      </View>
    </View>
  )
}
