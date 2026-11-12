/**
 * LetterEmptyState — "La carta" empty state for new conversations.
 *
 * Design: v4 mockup (/workspace/mockups/nueva-conversacion-carta-v4.html).
 * Editorial letter written in the agent's voice: avatar seal, greeting,
 * one prose paragraph with live system facts (emphasis + links), divider,
 * and three starter prompts that respond to the facts above.
 *
 * Data: assembled client-side from BoardApi (no backend changes needed).
 * Degrades gracefully — if board queries fail or return nothing, the
 * letter falls back to the static intro and the layout doesn't change.
 *
 * Links: facts with a navigable destination (agent / board) render as
 * dotted-underline links that call openWindow() — same pattern as Navbar.
 */

import React, { useEffect, useMemo, useState } from "react"
import { Platform, Pressable, ScrollView, Text as RNText, StyleSheet, View } from "react-native"
import { useTranslation } from "react-i18next"
import { YStack } from "tamagui"
import { useColors } from "../mca/primitives/useColors"
import { FONT_SERIF, FONT_MONO } from "../mca/primitives/fonts"
import { Ph } from "../ui/ds"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useTilingStore } from "../../store/tilingStore"
import { Avatar } from "../Avatar"

// ============================================================================
// TYPES
// ============================================================================

/** A navigable destination inside the app, opened via openWindow(). */
export type LetterTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "board"; projectId: string; projectName?: string; view?: string }
  | { kind: "channel"; channelId: string }

/** One segment of the letter's prose paragraph. */
export type LetterSegment =
  | { type: "text"; value: string }
  | { type: "em"; value: string }
  | { type: "link"; value: string; target: LetterTarget }

/** A starter prompt — tapping it sends the message directly. */
export interface LetterPrompt {
  /** Message sent when tapped */
  message: string
  /** Display text (defaults to message) */
  label?: string
}

interface LetterEmptyStateProps {
  /** Agent display name (e.g. "Alice Evergreen") */
  agentName: string
  /** Agent avatar URL */
  agentAvatarUrl: string | null
  /** Agent role (e.g. "Personal Assistant") */
  agentRole?: string
  /** Agent id — used for the avatar fallback and links */
  agentId?: string
  /** Workspace id — scopes the live board queries */
  workspaceId?: string
  /** User first name for the greeting */
  userName?: string
  /** Fired when a starter prompt is tapped */
  onPromptSelected: (message: string) => void
  /**
   * The user's "summary on a new conversation" preference (CSUM-REQ-4).
   * false: no letter is requested — only the seal and the greeting.
   */
  showSummary: boolean
}

// ============================================================================
// LIVE LETTER (backend-generated, agent's voice) + STATIC FALLBACK
// ============================================================================

/** Letter returned by the backend (channel.letter) — agent's own voice. */
interface BackendLetter {
  generated: boolean
  segments: LetterSegment[]
  prompts?: LetterPrompt[]
  boardNames?: string[]
}

// ============================================================================
// LETTER CACHE (module-level — survives remounts and Live Reload)
// ============================================================================

const LETTER_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  letter: BackendLetter | null
  expires: number
}

const letterCache = new Map<string, CacheEntry>()
const letterInFlight = new Map<string, Promise<BackendLetter | null>>()

const cacheKey = (agentId: string, workspaceId?: string, locale?: string) =>
  `${agentId}|${workspaceId ?? ""}|${locale ?? ""}`

/**
 * Fetch the live letter from the backend, cached for LETTER_TTL_MS per
 * (agent, workspace, locale). Remounts — navigation, Live Reload — reuse
 * the cached letter instead of regenerating; concurrent mounts share one
 * in-flight request. Best-effort: any failure returns null and the
 * component falls back to the static template.
 */
function fetchBackendLetter(
  agentId?: string,
  workspaceId?: string,
  locale?: string,
): Promise<BackendLetter | null> {
  if (!agentId) return Promise.resolve(null)
  const client = getTerosClient()
  if (!client?.channel?.letter) return Promise.resolve(null)

  const key = cacheKey(agentId, workspaceId, locale)
  const cached = letterCache.get(key)
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.letter)

  const inFlight = letterInFlight.get(key)
  if (inFlight) return inFlight

  const request = (async (): Promise<BackendLetter | null> => {
    try {
      const result = await client.channel.letter(agentId, { workspaceId, locale })
      // Only the agent-voice letter replaces the local template. The backend's
      // generated:false fallback carries bare data without i18n labels — the
      // local template (own snapshot + i18n) renders that case better.
      let letter: BackendLetter | null = null
      if (result?.generated && result?.segments?.length) {
        // Normalize backend segments into LetterSegment (target shape differs slightly)
        const segments: LetterSegment[] = result.segments.map((s) => {
          if (s.type === "link" && s.target) {
            if (s.target.kind === "board") {
              return {
                type: "link",
                value: s.value,
                target: {
                  kind: "board",
                  projectId: s.target.id,
                  projectName: s.target.name,
                  view: "kanban",
                },
              }
            }
            if (s.target.kind === "channel") {
              return {
                type: "link",
                value: s.value,
                target: { kind: "channel", channelId: s.target.id },
              }
            }
            return { type: "link", value: s.value, target: { kind: "agent", agentId: s.target.id } }
          }
          return { type: s.type, value: s.value } as LetterSegment
        })
        letter = { generated: result.generated, segments, prompts: result.prompts }
      }
      letterCache.set(key, { letter, expires: Date.now() + LETTER_TTL_MS })
      return letter
    } catch {
      return null
    } finally {
      letterInFlight.delete(key)
    }
  })()

  letterInFlight.set(key, request)
  return request
}

// ============================================================================
// COMPONENT
// ============================================================================

/** @spec CSUM-REQ-4 */
export function LetterEmptyState({
  agentName,
  agentAvatarUrl,
  agentRole,
  agentId,
  workspaceId,
  userName,
  onPromptSelected,
  showSummary,
}: LetterEmptyStateProps) {
  const { t, i18n } = useTranslation()
  const c = useColors()
  const openWindow = useTilingStore((s) => s.openWindow)

  // Letter request state: 'loading' → 'ready' (live letter) | 'failed'
  // The static template is ONLY shown when the request fails — the initial
  // screen (seal + greeting + hint icon) is a valid screen on its own.
  const [letterState, setLetterState] = useState<"loading" | "ready" | "failed">("loading")
  const [backendLetter, setBackendLetter] = useState<BackendLetter | null>(null)

  useEffect(() => {
    // CSUM-REQ-4: summary off — no letter request; the screen stays at the
    // seal + greeting.
    if (!showSummary) return
    let cancelled = false
    const locale = i18n.language || "en-US"
    fetchBackendLetter(agentId, workspaceId, locale).then((letter) => {
      if (cancelled) return
      if (letter) {
        setBackendLetter(letter)
        setLetterState("ready")
      } else {
        setLetterState("failed")
      }
    })
    return () => {
      cancelled = true
    }
  }, [agentId, workspaceId, i18n.language, showSummary])

  const liveSegments = letterState === "ready" ? (backendLetter?.segments ?? null) : null
  const livePrompts =
    letterState === "ready" && backendLetter?.prompts?.length ? backendLetter.prompts : null

  // Fallback prose — only rendered when the letter request failed
  const fallbackSegments = useMemo<LetterSegment[] | null>(() => {
    if (letterState !== "failed") return null
    return [
      { type: "text", value: t("conversation.letter.introStatic", { role: agentRole ?? "" }) },
    ]
  }, [letterState, t, agentRole])

  // Live letter wins; static fallback only on failure; null = still loading
  const proseSegments = liveSegments ?? fallbackSegments

  // Starters: live prompts with the letter; static i18n prompts only when
  // the request failed. While loading there are no starters — the hint icon
  // under the greeting signals that the letter is on its way.
  const staticPrompts = useMemo(() => STATIC_PROMPTS(t), [t])
  const promptsToShow = livePrompts ?? (letterState === "failed" ? staticPrompts : null)
  const promptSource = livePrompts ? "live" : "static"

  // ── Reveal choreography (onboarding-style) ──────────────────────────────
  // centered : seal + greeting + feather sit vertically centered
  // rising   : ¡clac! — the header glides up to its resting spot while the
  //            feather fades out; a quiet beat follows
  // prose    : the paragraph fades in
  // starters : the starter block fades in, a beat later
  const [phase, setPhase] = useState<"centered" | "rising" | "prose" | "starters">("centered")
  const [containerH, setContainerH] = useState(0)
  const [headerH, setHeaderH] = useState(0)

  useEffect(() => {
    if (letterState === "loading") return
    setPhase("rising")
    // Continuous flow — phases OVERLAP instead of waiting on each other:
    // glide (480ms slow) is still settling when the prose starts fading
    // (~550ms), and the prose is mid-fade when the starters join (~1.4s).
    const t1 = setTimeout(() => setPhase("prose"), 550)
    const t2 = setTimeout(() => setPhase("starters"), 1400)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [letterState])

  // Geometry: the header rests in the upper quarter — NOT at the very top,
  // so the letter body (prose + starters) lands lower on screen, with the
  // starters sitting near the composer as a "what's next" cue. While
  // centered it is pushed down by a translateY so it sits mid-screen.
  // headerH falls back to a close estimate until onLayout reports the real.
  const finalTop = Math.min(Math.max(containerH * 0.25, 88), 220)
  const effectiveHeaderH = headerH || 132
  const centeredY = Math.max(0, (containerH - effectiveHeaderH) / 2 - finalTop)

  const firstName = (userName ?? "").trim().split(/\s+/)[0] ?? ""
  const greeting = firstName
    ? t("conversation.letter.greeting", { name: firstName })
    : t("conversation.letter.greetingGeneric")

  const handleLink = (target: LetterTarget) => {
    // Preview routing (preview-tabs.md): a plain click reuses the desktop's
    // preview tab; only ctrl/cmd-click opens a separate tab.
    if (target.kind === "agent") {
      openWindow("agent", { agentId: target.agentId, workspaceId }, false)
    } else if (target.kind === "channel") {
      // Resume the thread — opens the conversation it references
      openWindow("chat", { channelId: target.channelId }, false)
    } else {
      openWindow(
        "board",
        {
          workspaceId,
          projectId: target.projectId,
          projectName: target.projectName,
          view: target.view ?? "kanban",
        },
        false,
      )
    }
  }

  /**
   * Inline span for a segment — nested inside ONE parent RNText so the text
   * engine wraps at character level (no orphaned commas/periods dropped to
   * their own line, which happened when each segment was a separate flex
   * item in a flexWrap row).
   */
  const renderSpan = (seg: LetterSegment, key: string) => {
    if (seg.type === "em") {
      return (
        <RNText key={key} style={{ color: c.accent }}>
          {seg.value}
        </RNText>
      )
    }
    if (seg.type === "link" && seg.target) {
      return (
        <RNText
          key={key}
          accessibilityRole="link"
          onPress={() => handleLink(seg.target)}
          style={{
            color: c.accent,
            textDecorationLine: "underline",
            textDecorationStyle: "dotted",
          }}
        >
          {seg.value}
        </RNText>
      )
    }
    return <RNText key={key}>{seg.value}</RNText>
  }

  const renderPrompt = (prompt: LetterPrompt, index: number) => (
    <Pressable
      key={index}
      onPress={() => onPromptSelected(prompt.message)}
      style={(state) => [
        styles.promptRow,
        state.pressed && { backgroundColor: c.nestHover },
        Platform.OS === "web"
          ? ({ cursor: "pointer", transition: "background 0.2s" } as any)
          : null,
      ]}
    >
      <RNText style={[styles.promptText, { color: c.text }]}>
        {prompt.label ?? prompt.message}
      </RNText>
      <Ph name="arrow-right" size={16} color={c.accent} />
    </Pressable>
  )

  return (
    <View style={styles.center} onLayout={(e) => setContainerH(e.nativeEvent.layout.height)}>
      {/* Header — absolutely positioned. It starts mid-screen (translateY)
          and glides up to its resting spot when the letter arrives, leaving
          room for the paragraph and the starters below. Hidden until the
          container geometry is known (avoids a first-frame jump). */}
      <YStack
        position="absolute"
        left={0}
        right={0}
        top={finalTop}
        alignItems="center"
        animation="slow"
        opacity={containerH > 0 ? 1 : 0}
        y={phase === "centered" ? centeredY : 0}
        onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)}
      >
        <View style={styles.sealWrap}>
          <Avatar
            name={agentName || "A"}
            imageUrl={agentAvatarUrl ?? undefined}
            size={72}
            isAgent
          />
        </View>
        <RNText style={[styles.greeting, { color: c.text }]}>{greeting}</RNText>
        {/* The feather — the letter is being written. Fades out in sync
            with the glide. */}
        <YStack marginTop={14} animation="medium" opacity={phase === "centered" && showSummary ? 1 : 0}>
          <Ph name="feather" size={24} color={c.text3} />
        </YStack>
      </YStack>

      {/* Letter body — scrollable, bounded below the resting header. Mounts
          only after the rise, so the header is already settled when text
          appears. On short screens the prose + starters can exceed the
          available height — ScrollView keeps them reachable (the starters
          were being clipped off-screen with no way to scroll). */}
      {(phase === "prose" || phase === "starters") && (
        <ScrollView
          style={{ flex: 1, width: "100%", marginTop: finalTop + effectiveHeaderH + 6 }}
          contentContainerStyle={{
            alignItems: "center",
            paddingHorizontal: 24,
            paddingBottom: 24,
          }}
          showsVerticalScrollIndicator={false}
        >
          {proseSegments && (
            <YStack width="100%" alignItems="center" animation="slow" enterStyle={{ opacity: 0 }}>
              <RNText style={[styles.prose, { color: c.text2 }]}>
                {proseSegments.map((seg, j) => renderSpan(seg, `seg-${j}`))}
              </RNText>
            </YStack>
          )}

          {phase === "starters" && promptsToShow && (
            <YStack
              key={promptSource}
              width="100%"
              alignItems="center"
              animation="medium"
              enterStyle={{ opacity: 0, y: 6 }}
            >
              <View style={styles.dividerWrap}>
                <View style={[styles.dividerLine, { backgroundColor: c.borderStrong }]} />
                <View style={[styles.dividerDot, { backgroundColor: c.text3 }]} />
                <View style={[styles.dividerLine, { backgroundColor: c.borderStrong }]} />
              </View>
              <RNText style={[styles.sectionLabel, { color: c.text3 }]}>
                {t("conversation.letter.startHere")}
              </RNText>
              <View style={styles.promptsWrap}>{promptsToShow.map(renderPrompt)}</View>
            </YStack>
          )}
        </ScrollView>
      )}
    </View>
  )
}

/** Generic starters shown when there are no live facts (or appended to fill up to 3). */
function STATIC_PROMPTS(t: (k: string, o?: any) => string): LetterPrompt[] {
  return [
    {
      message: t("conversation.letter.promptStatic1Message"),
      label: t("conversation.letter.promptStatic1"),
    },
    {
      message: t("conversation.letter.promptStatic2Message"),
      label: t("conversation.letter.promptStatic2"),
    },
    {
      message: t("conversation.letter.promptStatic3Message"),
      label: t("conversation.letter.promptStatic3"),
    },
  ]
}

// ============================================================================
// STYLES
// ============================================================================

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    // Header is absolutely positioned; the letter body scrolls from below
    // the resting header position (marginTop = resting top + height).
    justifyContent: "flex-start",
    gap: 0,
  },
  sealWrap: {
    marginBottom: 22,
    // The story ring IS the seal — no extra glow.
  },
  // `.t-3xl` compact — Prody 34, upright (the brand serif has no italic).
  greeting: {
    fontFamily: FONT_SERIF,
    fontWeight: "400",
    fontSize: 34,
    lineHeight: 38,
    letterSpacing: -0.34,
    textAlign: "center",
  },
  // `.prose` — Prody 17/1.6, centred letter body.
  prose: {
    fontFamily: FONT_SERIF,
    fontWeight: "400",
    fontSize: 17,
    lineHeight: 27,
    letterSpacing: 0.34,
    textAlign: "center",
    maxWidth: 480,
  },
  dividerWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 28,
    marginBottom: 16,
    width: 260,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  // `.t-codenote`
  sectionLabel: {
    fontFamily: FONT_MONO,
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 0.5,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  promptsWrap: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
  },
  promptRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  // `.t-hsm` — Prody 18/25, upright.
  promptText: {
    flex: 1,
    fontFamily: FONT_SERIF,
    fontWeight: "400",
    fontSize: 18,
    lineHeight: 25,
    letterSpacing: 0.36,
  },
})
