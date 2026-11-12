// ============================================================================
// USER MESSAGE BUBBLE
//
// Renders user messages — the OS prototype's `.msg.user .bubble`: a right
// aligned sans bubble on a soft MINT glow (Mint/100 in light, the mint tint
// in dark), mono timestamp under it. Queued → the mint shimmer, failed → pink.
// Also handles cross-channel messages (from other agents/users) with a
// neutral "isFromOther" style (card bubble + avatar).
//
// Text content is rendered as markdown via MarkdownContent (variant
// "bubble"), matching the rendering pipeline used by AgentTextBlock.
// ============================================================================

import type React from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, View } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { colors as semanticColors, surface } from "../mca/primitives/colors"
import { getDateLocale } from "../../i18n"
import { useAuthStore } from "../../store/authStore"
import type { Message } from "../../store/chatStore"
import { Avatar } from "../Avatar"
import { Ph, T } from "../ui/ds"
import {
  AudioBubble,
  FileBubble,
  ImageBubble,
  MarkdownContent,
  SelectableText,
  VoiceBubble,
  useChatPane,
} from "./bubbles"
import { QueuedIndicator, QueuedShimmer } from "./queuedDecorations"
import { fx } from "../../styles/fx"

/** Reading measure for a bubble (px). */
const BUBBLE_MAX_WIDTH = 560

export interface UserMessageBubbleProps {
  message: Message
  showTimestamp?: boolean
  onRetry?: (message: Message) => void
}

/**
 * User message bubble — right aligned on the mint glow.
 * Shows sender info when message is from another user/agent (not the current user).
 * Text content is rendered as markdown.
 */
export function UserMessageBubble({
  message,
  showTimestamp = true,
  onRetry,
}: UserMessageBubbleProps): React.ReactElement {
  const { t } = useTranslation()
  const c = useColors()
  const pane = useChatPane()
  const currentUserId = useAuthStore((state: any) => state.user?.userId)

  // Check if this message is from someone else (agent-to-agent or multi-user)
  const isFromOther = message.senderInfo && message.senderInfo.id !== currentUserId
  const senderName = isFromOther ? message.senderInfo?.name : null
  const senderAvatarUrl = isFromOther ? message.senderInfo?.avatarUrl : undefined
  const isAgentSender = isFromOther && message.senderInfo?.type === "agent"

  // Handle voice messages (with transcription)
  if (message.content.type === "voice") {
    return (
      <VoiceBubble
        url={message.content.url || ""}
        data={message.retryData?.audioData}
        duration={message.content.duration}
        transcription={message.content.transcription}
        transcriptionError={message.content.transcriptionError}
        timestamp={message.timestamp}
        isUser={true}
        showTimestamp={showTimestamp}
        status={message.status}
        onRetry={onRetry ? () => onRetry(message) : undefined}
      />
    )
  }

  // Handle audio messages (music, podcasts - no transcription)
  if (message.content.type === "audio") {
    return (
      <AudioBubble
        url={message.content.url}
        duration={message.content.duration}
        caption={message.content.caption}
        mimeType={message.content.mimeType}
        timestamp={message.timestamp}
        isUser={true}
        showTimestamp={showTimestamp}
        status={message.status}
        onRetry={onRetry ? () => onRetry(message) : undefined}
      />
    )
  }

  // Handle image messages from user
  if (message.content.type === "image") {
    return (
      <ImageBubble
        url={message.content.url}
        caption={message.content.caption}
        width={message.content.width}
        height={message.content.height}
        timestamp={message.timestamp}
        isUser={true}
        showTimestamp={showTimestamp}
        status={message.status}
      />
    )
  }

  // Handle file messages from user — FVU universal widget (4 actions always)
  if (message.content.type === "file") {
    return (
      <FileBubble
        url={message.content.url}
        filename={message.content.filename}
        caption={message.content.caption}
        mimeType={message.content.mimeType}
        size={message.content.size}
        filePath={message.content.filePath}
        workspaceId={message.content.workspaceId}
        channelId={message.channelId}
        timestamp={message.timestamp}
        isUser={true}
        showTimestamp={showTimestamp}
        status={message.status}
      />
    )
  }

  // System events addressed to the agent arrive as synthetic user messages
  // (content.type 'event' — e.g. app_auth_ready from the OAuth callback, and
  // historically permission resolutions). Render a compact event card instead
  // of falling into the "Unsupported message type" fallback. The agent-side
  // renderer (MessageBubble) has its own EventBubble for system-role events.
  if (message.content.type === "event") {
    const ec = message.content
    return (
      <View style={{ maxWidth: "85%", alignSelf: "flex-end" }}>
        <View
          style={{
            borderRadius: 14,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c.bgCard,
            paddingHorizontal: 12,
            paddingVertical: 10,
            gap: 4,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ph name="zap" size={13} color={c.tint.a.tx} />
            <T step="codenote" tone="text3">
              {ec.eventType ?? "event"}
            </T>
          </View>
          {ec.description ? (
            <T step="base" tone="text" selectable>
              {ec.description}
            </T>
          ) : null}
        </View>
        {showTimestamp ? (
          <T step="codenote" tone="text3" style={{ alignSelf: "flex-end", paddingRight: 4 }}>
            {message.timestamp.toLocaleTimeString(getDateLocale(), {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </T>
        ) : null}
      </View>
    )
  }

  // v2 non-blocking interactions: the form answer arrives as a synthetic user
  // message of type form_response — render a compact summary card instead of
  // the plain text bubble (spec §Implementation design 2).
  if (message.content.type === "form_response") {
    const fc = message.content
    const dismissed = fc.dismissed === true
    return (
      <View style={{ maxWidth: "85%", alignSelf: "flex-end", gap: 4 }}>
        <View
          style={{
            borderRadius: 14,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c.bgCard,
            paddingHorizontal: 12,
            paddingVertical: 10,
            gap: 6,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ph name={dismissed ? "x-circle" : "check-square"} size={13} color={c.tint.a.tx} />
            <T step="codenote" tone="text3">
              {dismissed
                ? t("conversation.formResponseDismissed", "Form dismissed")
                : t("conversation.formResponseTitle", "Form response")}
            </T>
          </View>
          {!dismissed && fc.values ? (
            <View style={{ gap: 2 }}>
              {Object.entries(fc.values).map(([k, v]) => (
                <T key={k} step="codenote" tone="text">
                  {k}: {String(v)}
                </T>
              ))}
              {fc.notes ? (
                <T step="codenote" tone="text3">
                  {t("conversation.formResponseNotes", "Notes")}: {fc.notes}
                </T>
              ) : null}
            </View>
          ) : null}
        </View>
        {showTimestamp ? (
          <T step="codenote" tone="text3" style={{ alignSelf: "flex-end", paddingRight: 4 }}>
            {message.timestamp.toLocaleTimeString(getDateLocale(), {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </T>
        ) : null}
      </View>
    )
  }

  if (message.content.type !== "text") {
    return (
      <View style={{ maxWidth: "85%", alignSelf: "flex-end" }}>
        <SelectableText color={c.text} fontSize="$3" selectable>
          {t("conversation.unsupportedMessageType", { type: message.content.type })}
        </SelectableText>
      </View>
    )
  }

  const text = message.content.text
  const isVoiceMessage = message.source === "voice"
  const isDark = c.bgPage === surface.dark.bgPage
  const isQueued = message.status === "queued"
  const isFailed = message.status === "failed"

  // `.bubble`: Mint/100 glow in light (Main/800 text = c.text), the mint
  // tint in dark (text = c.text). Failed → Pink/200 (`.msg.user.failed`).
  // "Other" bubbles (another agent or user writing in this channel) get the
  // same nebula — edges fully blurred into the sheet — in violet, so they
  // read as a voice that is neither yours nor this channel's agent.
  const mintFill = isDark ? c.tint.m.bg : semanticColors.mint100
  const failFill = isDark ? c.tint.r.bg : semanticColors.pink200
  const otherFill = isDark ? "rgba(156,107,255,0.16)" : semanticColors.purple100
  const bubbleBg = isFailed ? failFill : isFromOther ? otherFill : mintFill
  const glow = bubbleBg
  const textColor = isQueued ? c.text3 : c.text

  const time = message.timestamp.toLocaleTimeString(getDateLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  })

  return (
    <View
      {...fx("msg-user")}
      style={[
        {
          alignSelf: "flex-end",
          alignItems: "flex-end",
          maxWidth: pane.narrow ? "90%" : "84%",
          flexDirection: "row",
          minWidth: 0,
          gap: 8,
        },
        Platform.OS === "web" ? ({ userSelect: "text" } as any) : null,
      ]}
    >
      {/* Show avatar for messages from others */}
      {isFromOther && (
        <View style={{ alignSelf: "flex-start", marginTop: 14 }}>
          <Avatar
            name={senderName || "?"}
            imageUrl={senderAvatarUrl}
            size={28}
            isAgent={isAgentSender}
          />
        </View>
      )}

      {/* Capped at a reading measure: a long line or a wide code block never
          stretches the bubble across the thread (code blocks scroll inside). */}
      <View
        style={{
          flexShrink: 1,
          minWidth: 0,
          maxWidth: BUBBLE_MAX_WIDTH,
          alignItems: "flex-end",
          gap: 4,
        }}
      >
        {/* Show sender name for messages from others */}
        {isFromOther && senderName && (
          <T step="codenote" tone="text3" style={{ marginRight: 4 }}>
            {senderName}
          </T>
        )}

        {text.length > 0 && (
          <View
            style={[
              {
                paddingVertical: 10,
                paddingHorizontal: 18,
                borderRadius: 22,
                borderTopRightRadius: isFromOther ? 22 : 4,
                borderTopLeftRadius: isFromOther ? 4 : 22,
                backgroundColor: bubbleBg,
                overflow: isQueued ? "hidden" : undefined,
                position: "relative",
                maxWidth: "100%",
                minWidth: 0,
              },
              Platform.OS === "web"
                ? ({
                    boxShadow: `0 0 14px 8px ${glow}`,
                    transition: "background 0.3s, box-shadow 0.3s",
                  } as any)
                : null,
            ]}
          >
            {isQueued && <QueuedShimmer tone={isFromOther ? "neutral" : "mint"} />}
            <MarkdownContent text={text} variant="bubble" color={textColor} />
          </View>
        )}

        {/* `.msg .time` — mono 10 text3 under the bubble; accent while queued. */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
          {isQueued && <QueuedIndicator />}
          {isVoiceMessage && <Ph name="microphone" size={11} color={c.accent} />}
          {/* v2 non-blocking interactions: this message answered a pending
              form in chat — show the pointer so the thread reads connected. */}
          {message.respondsTo && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 3,
                paddingHorizontal: 7,
                height: 20,
                borderRadius: 100,
                backgroundColor: c.wash,
              }}
            >
              <Ph name="check-square" size={10} color={c.tint.a.tx} />
              <T step="codenote" color={c.text3}>
                {t("conversation.respondsToForm", "answered the form")}
              </T>
            </View>
          )}
          {showTimestamp && (
            <T step="codenote" color={isQueued ? c.accent : c.text3} selectable>
              {time}
            </T>
          )}
        </View>

        {/* `.msg-fail` — failed sends get the reason + a retry chip. */}
        {isFailed && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
            <Ph name="warning-circle" size={13} color={c.tint.r.tx} />
            <T step="12" color={c.tint.r.tx}>
              {t("chat.sendFailed", { defaultValue: "Not sent" })}
            </T>
            {onRetry && (
              <Pressable
                accessibilityRole="button"
                onPress={() => onRetry(message)}
                style={{
                  height: 24,
                  paddingHorizontal: 10,
                  borderRadius: 100,
                  backgroundColor: c.wash,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <T step="12" tone="text2">
                  {t("chat.retry", { defaultValue: "Retry" })}
                </T>
              </Pressable>
            )}
          </View>
        )}
      </View>
    </View>
  )
}
