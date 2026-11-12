import type React from "react"
import { useTranslation } from "react-i18next"
import { Platform, View } from "react-native"
import { YStack } from "tamagui"
import { useColors } from "./mca/primitives/useColors"
import { Ph, T } from "./ui/ds"
import { getDateLocale } from "../i18n"
import type { Message } from "../store/chatStore"
import { useTilingStore } from "../store/tilingStore"
import { useWorkspaceStore } from "../store/workspaceStore"
import {
  AudioBubble,
  EventBubble,
  FileBubble,
  HtmlBubble,
  HtmlFileBubble,
  ImageBubble,
  MarkdownContent,
  SelectableText,
  ToolCallBlock,
  VideoBubble,
  VoiceBubble,
  useChatPane,
} from "./chat/bubbles"
import { StreamingProse } from "./chat/bubbles/StreamingProse"
import { useVoiceSpeakingStore } from "../store/voiceSpeakingStore"
import { parseMarkdown } from "./chat/bubbles/MarkdownContent"
import { renderedText } from "./chat/bubbles/typeInReveal"
import { useTypewriterBoundary } from "../hooks/useTypewriter"
import { useMemo } from "react"
import { ErrorBlock } from "./ErrorBlock"
import { MessageFeedback } from "./MessageFeedback"
import { shouldShowMsgActions } from "./chat/msgActions"
import { Avatar } from "./Avatar"
import { ensureMcasRegistered } from "./mca"
import { ToolCallAuthorContext } from "./mca/types"

/** `.msg .time` — the mono timestamp of a message. */
function timeOf(d: Date): string {
  return d.toLocaleTimeString(getDateLocale(), { hour: "2-digit", minute: "2-digit" })
}

interface AgentRowProps {
  /** Open the turn with the avatar + "from" row (name · time). */
  showAuthor: boolean
  /**
   * Keep the 36px avatar gutter. Off for the channel's own agent: it is
   * already named in the chat header, so its turns carry no avatar, no
   * "from" row and run full width. Other agents (shared channels,
   * delegations) keep the identity row.
   */
  gutter?: boolean
  agentName: string
  agentAvatarUrl?: string | null
  timestamp: Date
  children: React.ReactNode
}

/**
 * `.msg.agent` — the agent turn of the OS prototype: a 36px story avatar at
 * the left, the "from" row (serif xl name + codenote time) and the body.
 * Continuations of the same turn keep the gutter so everything the agent
 * says lines up under its name. On a compact pane the avatar floats at the
 * top-left and the body takes the full width.
 */
function AgentRow({
  showAuthor,
  gutter = true,
  agentName,
  agentAvatarUrl,
  timestamp,
  children,
}: AgentRowProps): React.ReactElement {
  const pane = useChatPane()
  const from = showAuthor ? (
    <View
      style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 8, minWidth: 0 }}
    >
      <T step="xl" numberOfLines={1} style={{ flexShrink: 1 }}>
        {agentName}
      </T>
      <T step="codenote" tone="text3" selectable>
        {timeOf(timestamp)}
      </T>
    </View>
  ) : null

  if (pane.compact) {
    return (
      <View {...fx("msg-agent")} style={{ width: "100%" }}>
        {showAuthor && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <Avatar name={agentName} imageUrl={agentAvatarUrl ?? undefined} size={36} isAgent />
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                <T step="xl" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {agentName}
                </T>
                <T step="codenote" tone="text3" selectable>
                  {timeOf(timestamp)}
                </T>
              </View>
            </View>
          </View>
        )}
        <View style={{ width: "100%", minWidth: 0 }}>{children}</View>
      </View>
    )
  }

  if (!gutter) {
    return (
      <View {...fx("msg-agent")} style={{ width: "100%", minWidth: 0 }}>
        {children}
      </View>
    )
  }

  return (
    <View {...fx("msg-agent")} style={{ flexDirection: "row", gap: 14, width: "100%" }}>
      {showAuthor ? (
        <Avatar name={agentName} imageUrl={agentAvatarUrl ?? undefined} size={36} isAgent />
      ) : (
        <View style={{ width: 36, flexShrink: 0 }} />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        {from}
        {children}
      </View>
    </View>
  )
}

interface AgentTextBlockProps {
  message: Message
  isVoiceMsg: boolean
  showTimestamp: boolean
  isLastMessage: boolean
  /** Agent turn finished (control with the user). */
  turnDone?: boolean
  showAuthor: boolean
  /** See AgentRow.gutter — off for the channel's own agent. */
  gutter?: boolean
  agentName: string
  agentAvatarUrl?: string | null
  isChannelOwner?: boolean
  onToggleRedaction?: (messageId: string, redacted: boolean) => void
}
function AgentTextBlock({
  message,
  isVoiceMsg,
  showTimestamp,
  isLastMessage,
  turnDone = false,
  showAuthor,
  gutter,
  agentName,
  agentAvatarUrl,
  isChannelOwner,
  onToggleRedaction,
}: AgentTextBlockProps): React.ReactElement {
  const { t } = useTranslation()
  const c = useColors()
  const target = message.content.type === "text" ? message.content.text : ""
  // Type-in: animate while THIS message is streaming. We deliberately do
  // NOT gate on isLastMessage anymore — that flag flickers when a
  // tool_call / newer row appears below, which (a) snapped the text plain
  // mid-stream and (b) made the boundary go null → no blur. message.isStreaming
  // is stable for the whole turn (only cleared on agent idle), so the
  // reveal runs uninterrupted. Older bubbles have isStreaming=false → snap.
  const isStreaming = message.isStreaming === true
  // PoC 2026-10-31 — voice marking. Live: this message is the one SOUNDING
  // (speaking store) → paint heard chars normal, the rest muted, advancing
  // with the playback clock. Persisted: a barge-in left metadata.voice
  // (spokenChars) → the unheard tail stays muted for good. Only the matching
  // bubble re-renders (selector returns null for every other message).
  const live = useVoiceSpeakingStore((s) => (s.messageId === message.id ? s : null))
  const voiceMeta = (message.metadata as { voice?: { interrupted?: boolean; spokenChars?: number } } | undefined)?.voice
  const spokenChars = live ? live.charIndex : voiceMeta?.interrupted ? voiceMeta.spokenChars ?? 0 : null
  return (
    <View
      style={[
        { alignSelf: "flex-start", width: "100%" },
        Platform.OS === "web" ? ({ userSelect: "text" } as any) : null,
      ]}
    >
      <AgentRow
        showAuthor={showAuthor}
        gutter={gutter}
        agentName={agentName}
        agentAvatarUrl={agentAvatarUrl}
        timestamp={message.timestamp}
      >
        {spokenChars !== null ? (
          <SpokenProse text={target} spokenChars={spokenChars} live={!!live} />
        ) : (
          /* `.prose` — Prody 17/1.45, the editorial reply */
          <StreamingProse text={target} isStreaming={isStreaming} variant="prose" />
        )}
        {(isVoiceMsg || (showTimestamp && !showAuthor)) && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
            {isVoiceMsg && (
              // Voice Mode v2 (§3.4): the voice mark is a mic in the accent.
              // Same size as the timestamp meta: spoken words are first-class
              // content (UX §8.2).
              <>
                <Ph name="microphone" size={11} color={c.accent} />
                <T step="codenote" tone="accent">
                  {t("voice.bubble.mark", { defaultValue: "Voz" })}
                </T>
              </>
            )}
            {showTimestamp && !showAuthor && (
              <T step="codenote" tone="text3" selectable>
                {timeOf(message.timestamp)}
              </T>
            )}
          </View>
        )}
        {/* .msg-actions only under the LAST message of the channel once the turn is done */}
        {shouldShowMsgActions({ isLastMessage, turnDone, isStreaming: message.isStreaming === true }) && (
          <MessageFeedback
            messageId={message.id}
            channelId={message.channelId}
            messageText={target}
            currentRating={message.feedback?.rating}
            isChannelOwner={isChannelOwner}
            onToggleRedaction={onToggleRedaction}
          />
        )}
      </AgentRow>
    </View>
  )
}

/**
 * The spoken answer, rendered by the SAME prose renderer as every agent reply
 * (markdown, Prody 17/25, type-in spans) — only the reveal is driven by the
 * voice instead of the typewriter rhythm (Pablo, PoC 2026-10-31: "ir
 * pintando letra a letra" at the speed it is pronounced).
 *
 *  - live: the rendered text appears up to the character the audio has
 *    reached (ElevenLabs alignment → playback clock → source index → rendered
 *    index). No block swap when the audio ends: the full prose is the same
 *    component with the reveal removed.
 *  - interrupted (persisted metadata.voice): the whole reply stays, and
 *    everything past the heard char is painted in the muted grey of the
 *    overheard rows (Pablo: "lo que interrumpí que quede en gris clarito").
 */
function SpokenProse({ text, spokenChars, live }: { text: string; spokenChars: number; live: boolean }) {
  // Source index (what the TTS spoke, = the markdown source) → rendered index
  // (what the reveal counts). Parsing the heard prefix gives the exact count.
  const plainLen = useMemo(() => renderedText(parseMarkdown(text)).length, [text])
  const heardLen = useMemo(() => {
    const n = Math.max(0, Math.min(spokenChars, text.length))
    return Math.min(plainLen, renderedText(parseMarkdown(text.slice(0, n))).length)
  }, [text, spokenChars, plainLen])
  const shown = useMemo(() => renderedText(parseMarkdown(text)).slice(0, heardLen), [text, heardLen])
  // The freshly spoken chars enter with the DS type-in (blur → settle).
  const boundary = useTypewriterBoundary(shown, live, { scanSyntax: false })
  return (
    <MarkdownContent
      text={text}
      variant="prose"
      reveal={live ? { end: heardLen, boundary } : { end: heardLen, boundary: null, unheard: true }}
    />
  )
}

import { BoardEventBubble } from "./chat/BoardEventBubble"
import { BrowserbaseLiveViewBubble } from "./chat/bubbles/BrowserbaseLiveViewBubble"
import { RedactedMessageBubble } from "./chat/RedactedMessageBubble"
import { SystemMessageBubble } from "./chat/SystemMessageBubble"
import { UserMessageBubble } from "./chat/UserMessageBubble"
import { OverheardRow } from "./voice/OverheardRow"
import { fx } from "../styles/fx"

export type { MessageContent, ToolCall } from "./chat/bubbles"
// Re-export types for backwards compatibility
export type { Message }

// Ensure MCAs are registered on module load
ensureMcasRegistered()

interface MessageProps {
  message: Message
  showTimestamp?: boolean
  /** The agent ID of the channel (to determine if sender is the main agent) */
  channelAgentId?: string
  /** The channel agent's display name — the "from" row of agent turns. */
  channelAgentName?: string
  /** The channel agent's avatar — the story avatar of agent turns. */
  channelAgentAvatarUrl?: string | null
  /** Open an agent turn with avatar + name (first agent message after the user). Default true. */
  showAuthor?: boolean
  /** Channel visibility — when 'public', author avatar + name are shown per message (REQ-9, AC-12) */
  channelScope?: "personal" | "shared"
  isLastMessage?: boolean
  /** Agent turn finished (control with the user) — gates .msg-actions. */
  turnDone?: boolean
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
 * User message bubble - right aligned with indigo background
 * Shows sender info when message is from another user/agent (not the current user)
 *
 * Refactored into chat/UserMessageBubble.tsx — re-exported here for backwards
 * compatibility. Text content is now rendered as markdown via MarkdownContent.
 */
export const UserBubble = UserMessageBubble

/**
 * Agent message - left aligned, integrated into background (no bubble)
 * Used for the main channel agent's messages (fullwidth, no avatar)
 */
export function AgentMessage({
  message,
  showTimestamp = true,
  isLastMessage = false,
  turnDone = false,
  showAuthor = true,
  onRetry,
  channelAgentId,
  channelAgentName,
  channelAgentAvatarUrl,
  isChannelOwner,
  onToggleRedaction,
}: MessageProps): React.ReactElement {
  const { t } = useTranslation()
  const c = useColors()
  const openWindow = useTilingStore((s) => s.openWindow)
  // The agent turn always opens with its avatar + name (OS prototype
  // `.msg.agent .from`) — in shared conversations this doubles as the
  // authorship row (REQ-9, AC-12). senderInfo wins over the channel agent.
  const agentName = message.senderInfo?.name || channelAgentName || t("conversation.agent")
  const agentAvatarUrl = message.senderInfo?.avatarUrl ?? channelAgentAvatarUrl
  // The channel's own agent is already in the chat header (avatar · name),
  // so its turns carry no identity row. A message with no senderInfo is the
  // channel agent's; one that names another agent keeps its row.
  const sender = message.senderInfo
  const isChannelAgent =
    !sender ||
    sender.type !== "agent" ||
    (channelAgentId ? sender.id === channelAgentId : sender.name === channelAgentName)
  const authorShown = showAuthor && !isChannelAgent
  const row = (children: React.ReactNode) => (
    <AgentRow
      showAuthor={authorShown}
      gutter={!isChannelAgent}
      agentName={agentName}
      agentAvatarUrl={agentAvatarUrl}
      timestamp={message.timestamp}
    >
      {children}
    </AgentRow>
  )

  // Defensive null check: if content is null/undefined (e.g. backend sends null
  // for redacted messages before restart, or any future mismatch), render a
  // fallback instead of crashing on `message.content.type`.
  // @fixme nira - 2026.09.15 : this guard exists because loadMoreMessages
  // previously dropped the `redacted` flag, causing redacted messages with
  // null content to reach AgentMessage. The root cause is fixed in
  // useChatChannel.ts but this guard prevents any future mismatch from
  // crashing the entire window.
  if (!message.content) {
    return (
      <YStack alignSelf="flex-start" padding="$2">
        <SelectableText color={c.text3} fontSize="$3">
          {t("conversations.redacted.emptyContent", {
            defaultValue: "[Redacted content]",
          })}
        </SelectableText>
      </YStack>
    )
  }

  // Tool execution messages — single source of truth en message.content.
  // El array message.toolCalls[] era legado de streaming live; ahora upsertToolMessage
  // populate content directamente en cada chunk WS, así render persisted y streaming
  // colapsan al mismo path.
  if (message.content.type === "tool_execution") {
    return row(
      <View
        style={[
          { alignSelf: "flex-start", width: "100%", gap: 4 },
          Platform.OS === "web" ? ({ userSelect: "text" } as any) : null,
        ]}
      >
        <ToolCallAuthorContext.Provider value={{ name: agentName }}>
          <ToolCallBlock tool={message.content} />
        </ToolCallAuthorContext.Provider>
        {showTimestamp && !authorShown && (
          <T step="codenote" tone="text3" selectable>
            {timeOf(message.timestamp)}
          </T>
        )}
      </View>,
    )
  }

  // Handle image messages
  if (message.content.type === "image") {
    return row(
      <ImageBubble
        url={message.content.url}
        caption={message.content.caption}
        width={message.content.width}
        height={message.content.height}
        timestamp={message.timestamp}
        isUser={false}
        showTimestamp={showTimestamp}
        status={message.status}
      />,
    )
  }

  // Handle video messages
  if (message.content.type === "video") {
    return row(
      <VideoBubble
        url={message.content.url}
        caption={message.content.caption}
        duration={message.content.duration}
        thumbnailUrl={message.content.thumbnailUrl}
        timestamp={message.timestamp}
        isUser={false}
        showTimestamp={showTimestamp}
        status={message.status}
      />,
    )
  }

  // Handle voice messages (with transcription)
  if (message.content.type === "voice") {
    return row(
      <VoiceBubble
        url={message.content.url || ""}
        duration={message.content.duration}
        transcription={message.content.transcription}
        transcriptionError={message.content.transcriptionError}
        timestamp={message.timestamp}
        isUser={false}
        showTimestamp={showTimestamp}
      />,
    )
  }

  // Handle audio messages (music, podcasts - no transcription)
  if (message.content.type === "audio") {
    return row(
      <AudioBubble
        url={message.content.url}
        duration={message.content.duration}
        caption={message.content.caption}
        mimeType={message.content.mimeType}
        timestamp={message.timestamp}
        isUser={false}
        showTimestamp={showTimestamp}
      />,
    )
  }

  // Handle file messages — FVU universal widget (render by type + 4 actions).
  // filePath/workspaceId (live mode) are optional: old messages render by URL.
  if (message.content.type === "file") {
    return row(
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
        isUser={false}
        showTimestamp={showTimestamp}
        status={message.status}
      />,
    )
  }

  // Handle HTML widget messages
  if (message.content.type === "html") {
    return row(
      <HtmlBubble
        html={message.content.html}
        caption={message.content.caption}
        height={message.content.height}
        timestamp={message.timestamp}
        showTimestamp={showTimestamp}
      />,
    )
  }

  // Handle HTML file messages (send-html-file tool)
  if (message.content.type === "html_file") {
    return row(
      <HtmlFileBubble
        filePath={message.content.filePath}
        caption={message.content.caption}
        workspaceId={message.content.workspaceId}
        channelId={message.channelId}
        timestamp={message.timestamp}
        showTimestamp={showTimestamp}
      />,
    )
  }

  // Handle Browserbase Live View messages (session-create tool)
  if (message.content.type === "browser_live_view") {
    return row(
      <BrowserbaseLiveViewBubble
        sessionId={message.content.sessionId}
        url={message.content.url}
        caption={message.content.caption}
        timestamp={message.timestamp}
        showTimestamp={showTimestamp}
      />,
    )
  }

  // Handle system events (reminders, recurring tasks, etc.)
  if (message.content.type === "event") {
    return row(
      <EventBubble
        eventType={message.content.eventType}
        eventData={message.content.eventData}
        description={message.content.description}
        timestamp={message.timestamp}
        showTimestamp={showTimestamp}
      />,
    )
  }

  if (message.content.type === "text") {
    const isVoiceMsg = message.source === "voice"
    return (
      <AgentTextBlock
        message={message}
        isVoiceMsg={isVoiceMsg}
        showTimestamp={showTimestamp}
        isLastMessage={isLastMessage}
        turnDone={turnDone}
        showAuthor={authorShown}
        gutter={!isChannelAgent}
        agentName={agentName}
        agentAvatarUrl={agentAvatarUrl}
        isChannelOwner={isChannelOwner}
        onToggleRedaction={onToggleRedaction}
      />
    )
  }

  if (message.content.type === "error") {
    // Error messages don't carry agentId/senderInfo on the frontend store, so
    // the "Change model" action targets the channel's agent (opens its window).
    const targetAgentId = channelAgentId
      ? channelAgentId.startsWith("agent_")
        ? channelAgentId
        : `agent_${channelAgentId}`
      : undefined
    return row(
      <ErrorBlock
        errorType={message.content.errorType}
        userMessage={message.content.userMessage}
        technicalMessage={message.content.technicalMessage}
        context={message.content.context}
        timestamp={message.timestamp}
        onRetry={onRetry ? () => onRetry(message) : undefined}
        onChangeModel={
          targetAgentId
            ? () =>
                openWindow(
                  "agent",
                  {
                    agentId: targetAgentId,
                    workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
                  },
                  false,
                )
            : undefined
        }
      />,
    )
  }

  // Unsupported type
  return (
    <YStack alignSelf="flex-start">
      <SelectableText color={c.text} fontSize="$3" selectable>
        Unsupported message type: {(message.content as any).type}
      </SelectableText>
    </YStack>
  )
}

// Keep old export for backwards compatibility during migration
export function MessageBubble({
  message,
  showTimestamp = true,
  showAuthor = true,
  channelAgentId,
  channelAgentName,
  channelAgentAvatarUrl,
  channelScope,
  isLastMessage = false,
  turnDone = false,
  isChannelOwner,
  channelOwnerName,
  onToggleRedaction,
  onRetry,
}: MessageProps): React.ReactElement {
  // Redacted messages — render with RedactedMessageBubble (AC-5, AC-6, AC-7).
  // Owner: blurry content with click-to-reveal (content is present from backend).
  // Non-owner: "Protected by [owner]" placeholder (content is null, never received).
  if (message.redacted) {
    return (
      <RedactedMessageBubble
        message={message}
        isOwner={!!isChannelOwner}
        showTimestamp={showTimestamp}
        ownerName={channelOwnerName}
        onToggleRedaction={isChannelOwner ? onToggleRedaction : undefined}
      />
    )
  }

  // Board subscription messages — compact board event style
  if ((message.metadata as any)?.source === "board_subscription") {
    return <BoardEventBubble message={message} showTimestamp={showTimestamp} />
  }

  // System messages with text content — TerosLogo avatar + distinct indigo-tinted
  // bubble. Event/error content types are handled by AgentMessage's internal
  // routing (EventBubble / ErrorBlock), so we only intercept text-type system
  // messages here — those are the ones that previously rendered identically to
  // agent text with no visual distinction.
  if (message.sender === "system" && message.content?.type === "text") {
    return <SystemMessageBubble message={message} showTimestamp={showTimestamp} />
  }

  // User messages always use UserBubble (which handles isFromOther internally)
  // In public conversations, UserBubble already shows senderInfo (avatar + name) for other users.
  // EXCEPT overheard voice transcripts (REQ-9, fix 2026-10-05): they render as
  // the tenue OverheardRow — never as an indigo bubble. The overheard phrase
  // is context, not dialogue; a bubble would give it speaker weight it never
  // had (UX §3.4). This is the persisted half — the live WS frame no longer
  // renders its own row, so there is exactly ONE copy of each phrase.
  if (message.sender === "user") {
    if (message.source === "voice" && message.overheard) {
      return (
        <OverheardRow
          text={message.content.type === "text" ? message.content.text : ""}
          timestamp={message.timestamp}
        />
      )
    }
    return <UserBubble message={message} showTimestamp={showTimestamp} onRetry={onRetry} />
  }

  // For agent messages: check if it's from a different agent than the channel's main agent
  // If so, render as UserBubble with isFromOther styling (gray bubble with avatar)
  if (message.sender === "agent" && message.senderInfo && channelAgentId) {
    const isFromOtherAgent =
      message.senderInfo.id !== `agent_${channelAgentId}` &&
      message.senderInfo.id !== channelAgentId
    if (isFromOtherAgent) {
      // Render as "other user" style - gray bubble with avatar
      return <UserBubble message={message} showTimestamp={showTimestamp} onRetry={onRetry} />
    }
  }

  // Main channel agent messages go through AgentMessage (fullwidth, no avatar)
  return (
    <AgentMessage
      message={message}
      showTimestamp={showTimestamp}
      showAuthor={showAuthor}
      isLastMessage={isLastMessage}
      turnDone={turnDone}
      onRetry={onRetry}
      channelAgentId={channelAgentId}
      channelAgentName={channelAgentName}
      channelAgentAvatarUrl={channelAgentAvatarUrl}
      channelScope={channelScope}
      isChannelOwner={isChannelOwner}
      onToggleRedaction={onToggleRedaction}
    />
  )
}
