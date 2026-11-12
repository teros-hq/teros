// ============================================================================
// CONVERSATION PREVIEW
// Compact read-only transcript of a task's linked conversation, in the OS
// prototype language: a header strip with a Phosphor glyph + "Abrir" pill,
// user turns as ink bubbles, agent turns as name (accent) + markdown.
// ============================================================================

import type { AgentMapEntry } from "./board-utils"
import React, { useEffect, useRef, useState } from "react"
import { ScrollView, View } from "react-native"
import { useTranslation } from "react-i18next"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semantic } from "../../components/mca/primitives/colors"
import { AppSpinner } from "../../components/ui"
import { Btn, Ph, T } from "../../components/ui/ds"
import { getTerosClient } from "../../services/terosClientSingleton"
import { CompactMarkdown } from "./CompactMarkdown"

interface ConversationPreviewProps {
  channelId: string
  onOpenConversation: (channelId: string) => void
  agentMap: Record<string, AgentMapEntry>
}

/** Extract displayable text from a MessageContent object */
function getMessageText(content: any): string {
  if (!content) return ""
  if (typeof content === "string") return content // legacy fallback
  switch (content.type) {
    case "text":
      return content.text || ""
    case "voice":
      return content.transcription || "[Nota de voz]"
    case "image":
      return content.caption || "[Imagen]"
    case "video":
      return content.caption || "[Video]"
    case "audio":
      return content.caption || "[Audio]"
    case "file":
      return content.caption || content.filename || "[Archivo]"
    case "html":
      return content.caption || "[Widget HTML]"
    case "html_file":
      return content.caption || "[Archivo HTML]"
    case "tool_execution":
      return `🔧 ${content.toolName || "Tool call"}`
    case "event":
      return content.description || ""
    case "error":
      return content.userMessage || "[Error]"
    default:
      return ""
  }
}

/** Returns true if the message should be shown in the preview */
function isVisibleMessage(msg: any): boolean {
  if (!msg?.content) return false
  const type = msg.content.type
  // Skip internal event messages
  if (type === "event") return false
  // Only show user and assistant messages
  if (msg.role !== "user" && msg.role !== "assistant") return false
  return true
}

/** Whether a message is a tool call (compact card style) */
function isToolCall(msg: any): boolean {
  return msg?.content?.type === "tool_execution"
}

// ─── User bubble (right-aligned, ink pill) ───────────────────────────────────

function UserBubble({ text }: { text: string }) {
  const c = useColors()
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingLeft: 40 }}>
      <View
        style={{
          backgroundColor: c.inkPill,
          borderRadius: 16,
          borderBottomRightRadius: 4,
          paddingHorizontal: 12,
          paddingVertical: 8,
          maxWidth: "85%",
        }}
      >
        <T step="sm" tone="inkPill">
          {text}
        </T>
      </View>
    </View>
  )
}

// ─── Agent message (left-aligned, no bubble) ──────────────────────────────────

function AgentMessage({ text, agentName }: { text: string; agentName: string }) {
  const c = useColors()
  return (
    <View style={{ alignItems: "flex-start", paddingRight: 40, gap: 2 }}>
      <T step="12" tone="accent">
        {agentName}
      </T>
      <CompactMarkdown text={text} fontSize={13} color={c.text} />
    </View>
  )
}

// ─── Tool call card (compact nested row) ───────────────────────────────────────

function ToolCallCard({ content }: { content: any }) {
  const c = useColors()
  const toolName = content?.toolName || "Tool call"
  const status = content?.status
  const statusIcon =
    status === "completed"
      ? "check"
      : status === "failed"
        ? "x"
        : status === "running"
          ? "hourglass"
          : "dot"
  const statusColor =
    status === "completed" ? semantic.green : status === "failed" ? semantic.red : c.text3

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        backgroundColor: c.nest,
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 6,
      }}
    >
      <Ph name={statusIcon} size={12} color={statusColor} />
      <T step="code" tone="text2" ellipsis style={{ flex: 1 }}>
        {toolName}
      </T>
      {content?.duration ? (
        <T step="codenote" tone="text3">
          {content.duration}ms
        </T>
      ) : null}
    </View>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ConversationPreview({
  channelId,
  onOpenConversation,
  agentMap,
}: ConversationPreviewProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const [messages, setMessages] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const scrollRef = useRef<ScrollView>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        // Fetch last 30 messages; backend returns newest-first so we reverse
        const result = await client.channel.getMessages(channelId, 30)
        if (!cancelled) {
          const visible = (result.messages || [])
            .filter(isVisibleMessage)
            .reverse() // chronological order
            .slice(-20) // keep last 20
          setMessages(visible)
        }
      } catch (err) {
        console.error("Error loading conversation preview:", err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [channelId])

  return (
    <View style={{ flex: 1 }}>
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
          flexShrink: 0,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Ph name="chat-circle" size={13} color={c.accent} />
          <T step="xs" tone="text3">
            {t("board.conversationPreview.title", { defaultValue: "Conversation" })}
          </T>
        </View>
        <Btn
          size="sm"
          variant="mint"
          icon="chat-circle"
          iconRight="arrow-right"
          onPress={() => onOpenConversation(channelId)}
        >
          {t("board.conversationPreview.open", { defaultValue: "Abrir completa" })}
        </Btn>
      </View>

      {/* Messages */}
      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <AppSpinner size="sm" variant="default" />
        </View>
      ) : messages.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <T step="sm" tone="text3">
            {t("board.conversationPreview.empty", { defaultValue: "No messages yet" })}
          </T>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          {messages.map((msg, i) => {
            const isUser = msg.role === "user"
            const agentName =
              msg.sender?.name || (msg.agentId ? agentMap[msg.agentId]?.name : null) || "Agente"

            // Tool call card
            if (isToolCall(msg)) {
              return <ToolCallCard key={msg.messageId || i} content={msg.content} />
            }

            const rawText = getMessageText(msg.content)
            const text = rawText.length > 400 ? rawText.slice(0, 400) + "…" : rawText
            if (!text) return null

            if (isUser) {
              return <UserBubble key={msg.messageId || i} text={text} />
            }

            return <AgentMessage key={msg.messageId || i} text={text} agentName={agentName} />
          })}
        </ScrollView>
      )}
    </View>
  )
}
