// ============================================================================
// SYSTEM MESSAGE BUBBLE
//
// Renders messages with sender === "system" — platform-generated notifications
// like task creation, board events, reminders, etc.
// These are displayed with the Teros logo as avatar and a distinct visual style
// to differentiate them from user and agent messages: a washed card on the
// sheet with a "TEROS" codenote in the accent.
// ============================================================================

import type React from "react"
import { Platform, View } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { getDateLocale } from "../../i18n"
import type { Message } from "../../store/chatStore"
import { TerosLogo } from "../TerosLogo"
import { T } from "../ui/ds"
import { MarkdownContent } from "./bubbles"

interface SystemMessageBubbleProps {
  message: Message
  showTimestamp?: boolean
}

export function SystemMessageBubble({
  message,
  showTimestamp = true,
}: SystemMessageBubbleProps): React.ReactElement {
  const c = useColors()

  // Extract text from either event or text content types
  const text =
    message.content.type === "text"
      ? message.content.text
      : message.content.type === "event"
        ? message.content.description
        : ""

  // For event-type messages, use the event description as fallback
  const displayText =
    text || (message.content.type === "event" ? message.content.eventData?.message : "") || ""

  return (
    <View
      style={[
        {
          maxWidth: "85%",
          flexDirection: "row",
          gap: 10,
          alignSelf: "flex-start",
          alignItems: "flex-start",
        },
        Platform.OS === "web" ? ({ userSelect: "text" } as any) : null,
      ]}
    >
      {/* Teros logo avatar */}
      <View style={{ paddingTop: 8 }}>
        <TerosLogo size={20} color={c.accent} animated={false} />
      </View>

      <View
        style={{
          flex: 1,
          backgroundColor: c.navActive,
          borderRadius: 16,
          borderTopLeftRadius: 4,
          paddingVertical: 12,
          paddingHorizontal: 14,
          gap: 6,
        }}
      >
        {/* "Teros" label */}
        <T step="codenote" tone="accent">
          Teros
        </T>

        {/* Message content — rendered as markdown */}
        {displayText && <MarkdownContent text={displayText} />}

        {/* Timestamp */}
        {showTimestamp && (
          <T step="codenote" tone="text3">
            {message.timestamp.toLocaleTimeString(getDateLocale(), {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </T>
        )}
      </View>
    </View>
  )
}
