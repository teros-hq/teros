// ============================================================================
// REDACTED MESSAGE BUBBLE
//
// Renders a redacted message with two visual modes:
//
// 1. Owner view (isOwner=true): The owner has the full content from the backend
//    (content is NOT stripped for owners). The message is shown blurry as a
//    visual placeholder. Clicking reveals the content (click-to-reveal).
//    A "Redact"/"Un-redact" toggle is shown in the message menu.
//
// 2. Non-owner view (isOwner=false): The backend sends obfuscated content where
//    all alphanumeric characters are replaced with the middle dot (·, U+00B7).
//    We render this as Markdown (structure visible) with a permanent blur overlay.
//    The "Protected by [owner]" header bar is shown above the content.
//    The original content does NOT exist in the client — we never attempt to
//    recover it.
//
// Spec: AC-5 (owner blur + click-to-reveal), AC-6 (non-owner placeholder),
//       AC-7 (owner can un-redact). REQ-4, REQ-5, NFR-2.
// ============================================================================

import type React from "react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, View } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { Ph, T } from "../ui/ds"
import { MarkdownContent } from "./bubbles"
import { getDateLocale } from "../../i18n"
import type { Message } from "../../store/chatStore"

export interface RedactedMessageBubbleProps {
  message: Message
  isOwner: boolean
  showTimestamp?: boolean
  /** Owner name for the "Protected by [owner]" label (non-owner view). */
  ownerName?: string
  /** Whether the redact/un-redact menu action is available (owner only). */
  onToggleRedaction?: (messageId: string, redacted: boolean) => void
}

const BLUR =
  Platform.OS === "web" ? ({ filter: "blur(5px)", opacity: 0.7 } as any) : { opacity: 0.35 }

/**
 * RedactedMessageBubble — renders a redacted message.
 *
 * Owner: blurry Markdown content with click-to-reveal. The owner has the full
 * content from the backend, so we can safely show it blurred and reveal on click.
 *
 * Non-owner: obfuscated Markdown content (all alphanumeric chars replaced with ·)
 * rendered from the backend payload, with a permanent blur overlay. The "Protected
 * by [owner]" header bar is shown above. The original content was never sent.
 */
export function RedactedMessageBubble({
  message,
  isOwner,
  showTimestamp = true,
  ownerName,
  onToggleRedaction,
}: RedactedMessageBubbleProps): React.ReactElement {
  const { t } = useTranslation()
  const c = useColors()
  const [revealed, setRevealed] = useState(false)

  const card = [
    { padding: 14, borderRadius: 16, backgroundColor: c.bgStep },
    Platform.OS === "web" ? ({ boxShadow: c.liftSm } as any) : null,
  ]
  const bar = (dashed: boolean) => ({
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    alignSelf: "flex-start" as const,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 100,
    backgroundColor: c.tint.i.bg,
    borderWidth: 1,
    borderColor: c.tint.i.bd,
    borderStyle: (dashed ? "dashed" : "solid") as "dashed" | "solid",
  })

  // ── Non-owner view: obfuscated content with permanent blur ────────
  // The backend sends obfuscated text (all alphanumeric chars replaced with ·).
  // We render it as Markdown so the structure is visible, with a permanent blur.
  // The original content does NOT exist in the client and must never be recovered.
  if (!isOwner) {
    const placeholder = message.redactedPlaceholder
    const timestamp = placeholder ? new Date(placeholder.originalTimestamp) : message.timestamp
    const obfuscatedText = message.content?.type === "text" ? message.content.text : ""

    return (
      <View
        style={[
          { gap: 8, alignSelf: "flex-start", width: "100%" },
          Platform.OS === "web" ? ({ userSelect: "none" } as any) : null,
        ]}
      >
        {/* Protected-by header bar */}
        <View style={bar(true)}>
          <Ph name="shield" size={14} color={c.tint.i.tx} />
          <T step="12" color={c.tint.i.tx}>
            {t("conversations.redacted.protectedBy", {
              owner: ownerName || t("conversations.redacted.owner"),
              defaultValue: "Protected by {{owner}}",
            })}
          </T>
        </View>

        {/* Obfuscated content — permanently blurred, no click-to-reveal */}
        <View style={[...card, BLUR]}>
          {obfuscatedText ? (
            <MarkdownContent text={obfuscatedText} variant="prose" />
          ) : (
            <T step="sm" tone="text3">
              {t("conversations.redacted.emptyContent", {
                defaultValue: "[Redacted content]",
              })}
            </T>
          )}
        </View>

        {showTimestamp && (
          <T step="codenote" tone="text3" selectable>
            {timestamp.toLocaleTimeString(getDateLocale(), {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </T>
        )}
      </View>
    )
  }

  // ── Owner view: blurry content with click-to-reveal ────────────────
  // The owner has the full content from the backend (content is NOT stripped
  // for owners). We show it blurred as a visual cue. Clicking reveals it.
  const text = message.content?.type === "text" ? message.content.text : ""

  return (
    <View
      style={[
        { gap: 8, alignSelf: "flex-start", width: "100%" },
        Platform.OS === "web" ? ({ userSelect: revealed ? "text" : "none" } as any) : null,
      ]}
    >
      {/* Redaction indicator bar */}
      <View style={bar(false)}>
        <Ph name="shield" size={14} color={c.tint.i.tx} />
        <T step="12" color={c.tint.i.tx}>
          {t("conversations.redacted.redactedLabel", {
            defaultValue: "Redacted",
          })}
        </T>
        {onToggleRedaction && (
          <Pressable
            onPress={() => onToggleRedaction(message.id, false)}
            accessibilityRole="button"
          >
            <T step="12" tone="accent" style={{ textDecorationLine: "underline" }}>
              {t("conversations.redacted.unredact", {
                defaultValue: "Un-redact",
              })}
            </T>
          </Pressable>
        )}
      </View>

      {/* Blurry content — click to reveal */}
      <Pressable
        onPress={() => setRevealed((r) => !r)}
        style={[
          ...card,
          revealed ? null : BLUR,
          Platform.OS === "web"
            ? ({ cursor: "pointer", transition: "filter 0.3s, opacity 0.3s" } as any)
            : null,
        ]}
      >
        <MarkdownContent
          variant="prose"
          text={
            text ||
            t("conversations.redacted.emptyContent", {
              defaultValue: "[Redacted content]",
            })
          }
        />
      </Pressable>

      {/* Click-to-reveal hint + timestamp */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Pressable
          onPress={() => setRevealed((r) => !r)}
          accessibilityRole="button"
          style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
        >
          <Ph name={revealed ? "eye-slash" : "eye"} size={12} color={c.text3} />
          <T step="12" tone="text3">
            {revealed
              ? t("conversations.redacted.clickToHide", {
                  defaultValue: "Click to hide",
                })
              : t("conversations.redacted.clickToReveal", {
                  defaultValue: "Click to reveal",
                })}
          </T>
        </Pressable>
        {showTimestamp && (
          <T step="codenote" tone="text3" selectable>
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
