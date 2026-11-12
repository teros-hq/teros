import { UI_HIDDEN_PROXY_TOOLS } from "@teros/shared"
import React from "react"
import { View } from "react-native"
import { type Message, useChatStore } from "../store/chatStore"
import { MessageBubble } from "./MessageBubble"
import { useFeatureFlag } from "../hooks/useFeatureFlag"
import { OverheardRow } from "./voice/OverheardRow"
import { THREAD_MAX_WIDTH, threadPadH, useChatPane } from "./chat/bubbles"

interface MessageItemProps {
  messageId: string
  previousMessageId?: string
  nextMessageId?: string
  /** The agent ID of the channel (to determine if sender is the main agent) */
  channelAgentId?: string
  /** The channel agent's display name — the "from" row of agent messages. */
  channelAgentName?: string
  /** The channel agent's avatar — the 36px story avatar of agent messages. */
  channelAgentAvatarUrl?: string | null
  /** Channel visibility — when 'public', author avatar + name are shown per message (REQ-9, AC-12) */
  channelScope?: "personal" | "shared"
  /** Whether the current user is the channel owner/creator (for redaction UI, REQ-4) */
  isChannelOwner?: boolean
  /** Owner display name (for non-owner "Protected by" label, AC-6) */
  channelOwnerName?: string
  /** Callback to toggle redaction on a message (owner only, AC-5/AC-7) */
  onToggleRedaction?: (messageId: string, redacted: boolean) => void
  /** Callback to retry sending a failed message */
  onRetry?: (message: Message) => void
}

/**
 * Check if two timestamps are in the same minute
 */
function isSameMinute(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate() &&
    date1.getHours() === date2.getHours() &&
    date1.getMinutes() === date2.getMinutes()
  )
}

/**
 * MessageItem - Wrapper component that subscribes to a single message by ID
 *
 * This component only re-renders when THIS specific message changes,
 * not when other messages in the channel change.
 *
 * This is the key to avoiding infinite loops with large message lists.
 *
 * Layout: every row is a slice of the prototype's `.thread-in` — 760px max,
 * centred, with the thread's horizontal padding; the gap between messages
 * (18px, 6px inside one turn) is the row's top padding.
 */
export const MessageItem = React.memo(
  ({
    messageId,
    previousMessageId,
    nextMessageId,
    channelAgentId,
    channelAgentName,
    channelAgentAvatarUrl,
    channelScope,
    isChannelOwner,
    channelOwnerName,
    onToggleRedaction,
    onRetry,
  }: MessageItemProps) => {
    // Subscribe ONLY to this specific message (granular selector)
    const message = useChatStore((state) => state.messages[messageId])
    const previousMessage = useChatStore((state) =>
      previousMessageId ? state.messages[previousMessageId] : undefined,
    )
    const nextMessage = useChatStore((state) =>
      nextMessageId ? state.messages[nextMessageId] : undefined,
    )
    // Turn finished = control is back with the user: the channel is not typing
    // and the agent phase is idle/unset. Boolean selector — flips once per turn.
    const turnDone = useChatStore((state) => {
      const ch = state.channels[message?.channelId ?? ""]
      return !ch?.isTyping && (ch?.agentPhase === undefined || ch.agentPhase === "idle")
    })
    // Voice Mode v2 UI flag — read BEFORE any early return (Rules of Hooks).
    // Off = legacy voice rendering, zero regression.
    const voiceModeUi = useFeatureFlag<boolean>("voice.mode-ui")
    const pane = useChatPane()
    const padH = threadPadH(pane)

    // If message doesn't exist (shouldn't happen), render nothing
    if (!message) {
      console.warn("[MessageItem] Message not found in store:", messageId)
      return null
    }

    // Tool-execution proxy discovery is invisible in the chat: list-installed-apps
    // and list-app-tools render nothing at all (no padding, no timestamp).
    // execute-tool calls arrive already tunneled to the target tool's name.
    if (
      message.content?.type === "tool_execution" &&
      UI_HIDDEN_PROXY_TOOLS.includes(message.content.toolName)
    ) {
      return null
    }

    // Inline forms v2: the synthetic `form_response` user message (saved by the
    // backend on submit/dismiss for history fidelity + the agent wake) renders
    // NOTHING in the thread — the resolved FormWidget tool card is the single,
    // human-friendly read-back (labels of fields and options, never field ids
    // or raw values). Without this, the answer rendered TWICE: the tool card
    // plus this raw "Form response" bubble (bug 2026-10-26, ch_de51f84c1da0e183).
    // The message itself stays in the store and in channel history — the agent
    // still consumes the field-id-keyed values from it.
    if (message.content?.type === "form_response") {
      return null
    }

    // Voice Mode v2 (F3b, REQ-9 — decisión de Pablo #5): an overheard voice
    // transcript (heard-but-not-addressed) renders as the tenue row IN the
    // thread — left-aligned, opacity ~0.55, "Voz · escuchado" — regardless of
    // who spoke it. Routed here, before the user/agent bubble dispatch, so
    // it never lands on the user's right side. Flag-gated: off = the bubble
    // renders as before (zero regression).
    if (
      voiceModeUi &&
      message.source === "voice" &&
      message.overheard === true &&
      message.content?.type === "text"
    ) {
      return (
        <View
          style={{
            width: "100%",
            maxWidth: THREAD_MAX_WIDTH + padH * 2,
            alignSelf: "center",
            paddingHorizontal: padH,
            paddingVertical: 4,
          }}
        >
          <OverheardRow text={message.content.text} timestamp={message.timestamp} />
        </View>
      )
    }

    // Voice Mode v2 (F3b): the backend persists internal delegation lines
    // (🛠️ send-message →, 🛠️ execute-tool →, ❌ Error en …) as plain text
    // with source:'voice'. In the unified thread they are technical
    // duplicates — the human delegation rows (channel_event frames) already
    // tell the story ("Jordan empezó a trabajar"). Suppress them, the same
    // filter the legacy TranscriptDisplay applied to historic transcripts
    // (voice-handler :2528-2531). Flag-gated: off = raw text renders as
    // before (zero regression). Note: '✅ Respuesta de agente' is NOT
    // suppressed — the worker's answer is real content, rendered as a
    // normal agent bubble.
    if (
      voiceModeUi &&
      message.source === "voice" &&
      message.content?.type === "text" &&
      (message.content.text.startsWith("🛠️") || message.content.text.startsWith("❌ Error en"))
    ) {
      return null
    }

    // Determine if we should show timestamp (hide if same minute as next message from same sender)
    const showTimestamp =
      !nextMessage ||
      nextMessage.sender !== message.sender ||
      !isSameMinute(message.timestamp, nextMessage.timestamp)

    // Determine if this is a consecutive message from the same sender within the same minute
    const isConsecutive =
      previousMessage &&
      previousMessage.sender === message.sender &&
      isSameMinute(previousMessage.timestamp, message.timestamp)

    // The "from" row (avatar + name) opens an agent TURN: the first agent
    // message after anything that is not the agent. Tool calls and text in
    // the same turn share one header.
    const showAuthor = !previousMessage || previousMessage.sender !== message.sender

    // Gap before this row: a new turn gets the thread gap; inside a turn,
    // tool lines stack tight (8, the prototype's `.tlines` rhythm), a
    // paragraph after a tool line breathes (16), a tool line after a
    // paragraph a little less (12).
    const isToolCall = message.content?.type === "tool_execution"
    const isPrevToolCall = previousMessage?.content?.type === "tool_execution"
    // A BUBBLE (the user's mint one, or the violet one of another agent or
    // user) always opens with the turn gap, even after a row of the same
    // sender — an overheard line before the user's bubble, or the channel
    // agent's prose before another agent's bubble, otherwise fell into the
    // 8px "consecutive" rhythm (Pablo, PoC 2026-10-31: "debería tener un
    // margin top").
    const isOtherAgent =
      message.sender === "agent" &&
      !!message.senderInfo &&
      !!channelAgentId &&
      message.senderInfo.id !== `agent_${channelAgentId}` &&
      message.senderInfo.id !== channelAgentId
    const isBubble =
      message.content?.type === "text" &&
      ((message.sender === "user" && !(message.source === "voice" && message.overheard)) || isOtherAgent)
    const paddingTop = !previousMessage
      ? 0
      : showAuthor || isBubble
        ? pane.compact
          ? 24
          : 18
        : isToolCall && isPrevToolCall
          ? 8
          : isPrevToolCall
            ? 16
            : isToolCall
              ? 12
              : isConsecutive
                ? 8
                : 14

    return (
      <View
        style={{
          width: "100%",
          maxWidth: THREAD_MAX_WIDTH + padH * 2,
          alignSelf: "center",
          paddingHorizontal: padH,
          paddingTop,
        }}
      >
        <MessageBubble
          message={message}
          showTimestamp={showTimestamp}
          showAuthor={showAuthor}
          channelAgentId={channelAgentId}
          channelAgentName={channelAgentName}
          channelAgentAvatarUrl={channelAgentAvatarUrl}
          channelScope={channelScope}
          isChannelOwner={isChannelOwner}
          channelOwnerName={channelOwnerName}
          onToggleRedaction={onToggleRedaction}
          isLastMessage={!nextMessage}
          turnDone={turnDone}
          onRetry={onRetry}
        />
      </View>
    )
  },
)

MessageItem.displayName = "MessageItem"
