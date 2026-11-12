/**
 * PresenceOrb — the body of Alice (ui-evolution.md §3.1) ⭐
 *
 * A 48px (mobile) / 52px (desktop) circle with the agent avatar at its
 * center and a halo whose COLOR encodes presence+mode and whose ANIMATION
 * encodes activity. It breathes always — the breathing period comes from
 * the mode (UX §3.2): 7s passive · 2.5s conversation.
 *
 * ⚠️ HARD RULE (AC-UX2): NO animation may simulate audio that does not
 * exist. The echo (hearing) is driven ONLY by the real audioLevel of the
 * mic; the speaking ring ONLY by real agent playback. thinking /
 * waiting_worker / reconnecting show NO waveform at all — no theatre.
 * (This is the rule that deprecated VoiceVisualizer — Math.random bars.)
 *
 * Where it lives: floating bottom-right of the chat area, just above the
 * composer (ChatView mounts it as a sibling of the composer with absolute
 * positioning). Tap → popover: mode (same ModePicker), "¿qué has oído?"
 * (last heard phrase), and hang up.
 *
 * Its DNA is the AgentAvatar of VoiceControls (:89-138) — same indigo ring
 * pulse, grown to ambient size and split by axis.
 *
 * Badges: moon (passive), alert sign (error).
 *
 * Look (OS prototype): the popover is a `.menu` card — radius 16, one step
 * off the sheet, hairline border, raised shadow, 6px padding, `.mi` rows;
 * the accent ring reads `c.accent` (violet on both sheets); Phosphor glyphs.
 *
 * Gated by the voice.mode-ui feature flag — off = the orb is not mounted
 * at all and the legacy composer swap keeps working (zero regression).
 */

import React, { useEffect, useRef, useState } from "react"
import { Animated, Easing, Image, Platform, Pressable, View as RNView } from "react-native"
import { Popover } from "tamagui"
import type { VoiceActivity, VoiceMode, VoicePresence } from "@teros/shared"
import { useColors } from "../mca/primitives/useColors"
import { colors } from "../mca/primitives/colors"
import { useTranslation } from "react-i18next"
import { useReducedMotion } from "../../hooks/useReducedMotion"
import { Dot, Ph, T } from "../ui/ds"
import { MenuRow, MenuSection } from "./MenuRow"
import { ModePicker, MODE_COLORS, MODE_ICONS } from "./ModePicker"

// ─── Breathing periods by mode (UX §3.2) ─────────────────────────────────────

const BREATH_PERIOD_MS: Record<VoiceMode, number> = {
  available: 9000, // gris, 9 s — la respiración más lenta: está, sin más
  passive: 7000, // gris, 7 s — respiración lenta
  conversation: 2500, // índigo intenso, 2.5 s — respiración viva
}

// ─── Rest drift (UX §3.2: "deriva a reposo") ──────────────────────────────────

/** 3 min without conversational activity → the orb drifts to rest. */
const REST_DRIFT_MS = 180_000
/** While resting, breathing is ×1.5 slower — presence without anxiety. */
const REST_BREATH_SLOWDOWN = 1.5
/** Activities that count as "conversational" — they reset the drift timer.
 *  hearing wakes the orb (§3.2: "despierta con la primera sílaba"). */
const CONVERSATIONAL_ACTIVITIES: VoiceActivity[] = [
  "hearing",
  "speaking",
  "thinking",
  "waiting_worker",
]

// ─── Props ───────────────────────────────────────────────────────────────────

export interface PresenceOrbProps {
  presence: VoicePresence
  mode: VoiceMode
  activity: VoiceActivity
  /**
   * Real audio level 0-1 (AC-UX2): the USER's mic while hearing (drives the
   * green echo), the AGENT's TTS playback while speaking (drives the indigo
   * speaking ring + the body's protagonism — F5c, "el wow-wow" de Pablo).
   * Never simulated: the context polls the real analyser.
   */
  audioLevel: number
  /** Agent avatar URL (the body's face). */
  agentAvatarUrl?: string
  /** Agent display name (fallback initial + popover title). */
  agentName?: string
  /** Last heard phrase — feeds the popover "¿qué has oído?" (§3.1). */
  lastHeard?: string | null
  /** Worker name while waiting_worker (for the timer chip, §3.8). */
  workerName?: string | null
  /** Reconnect attempt n/5 for the reconnecting label. */
  reconnectAttempt?: number
  /** Selects a mode → set_mode frame (UI door). */
  onSetMode: (mode: VoiceMode) => void
  /**
   * Mute/unmute the mic (F5c: the orb popover is the single control surface
   * of the v2 path — mute lives here, next to mode and hang up).
   * Optional: the legacy path keeps mute in VoiceControls.
   */
  onToggleMute?: () => void
  /** Current mute state (drives the popover row's icon + label). */
  isMuted?: boolean
  /**
   * Jump back to the conversation this voice session belongs to (Pablo,
   * 2026-10-05 — the orb's 3rd door: mute · mode · jump). Optional so the
   * render tests and any orb-only mount keep working.
   */
  onJumpToConversation?: () => void
  /** Hang up (stopSession). */
  onDisconnect: () => void
  /** Diameter override (the navbar block hosts a smaller orb). Default 52 web / 48 native. */
  size?: number
}

// ─── The orb ──────────────────────────────────────────────────────────────────

const ORB_SIZE_DEFAULT = Platform.OS === "web" ? 52 : 48

export function PresenceOrb({
  presence,
  mode,
  activity,
  audioLevel,
  agentAvatarUrl,
  agentName,
  lastHeard,
  workerName,
  reconnectAttempt,
  onSetMode,
  onToggleMute,
  isMuted,
  onJumpToConversation,
  onDisconnect,
  size,
}: PresenceOrbProps) {
  const ORB_SIZE = size ?? ORB_SIZE_DEFAULT
  const { t } = useTranslation()
  const c = useColors()

  // Breathing — always on while present, period from the mode.
  const breath = useRef(new Animated.Value(0)).current
  // Echo scale — driven ONLY by the real audioLevel (AC-UX2).
  const echo = useRef(new Animated.Value(0)).current
  // Speaking ring scale — driven ONLY by the real TTS playback level
  // (F5c, AC-UX2): the "wow-wow" of the agent's actual voice.
  const speak = useRef(new Animated.Value(0)).current
  // Recognition flash — pop when an invocation is accepted (hearing onset).
  const flash = useRef(new Animated.Value(0)).current
  const [flashKey, setFlashKey] = useState(0)

  // ── Accessibility (UX §11.2 / AC-UX12): prefers-reduced-motion ──
  // No looping breathing, no flash pop, no echo animation — the orb keeps
  // its state as STATIC opacity/color (state is never color-only: the
  // popover label carries it in text too).
  const reducedMotion = useReducedMotion()

  // ── Rest drift (UX §3.2: "deriva a reposo") ──────────────────────────────
  // After 3 min without conversational activity the orb drifts to rest:
  // halo one step fainter + breathing ×1.5 slower. The first syllable
  // (hearing) wakes it. Reduced-motion: only the static opacity changes.
  const [isResting, setIsResting] = useState(false)
  useEffect(() => {
    if (presence === "off") {
      setIsResting(false)
      return
    }
    if (CONVERSATIONAL_ACTIVITIES.includes(activity)) {
      setIsResting(false) // conversational activity (re)sets the drift
      return
    }
    // idle → arm the drift timer; hearing wakes the orb on the next render.
    const id = setTimeout(() => setIsResting(true), REST_DRIFT_MS)
    return () => clearTimeout(id)
  }, [presence, activity])

  // Breathing loop with the mode's period — resting breathes ×1.5 slower.
  useEffect(() => {
    if (presence === "off") return
    // Reduced-motion: no loop at all — the halo stays at a static opacity.
    if (reducedMotion) {
      breath.setValue(0.5)
      return
    }
    const half = (BREATH_PERIOD_MS[mode] * (isResting ? REST_BREATH_SLOWDOWN : 1)) / 2
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: half,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: half,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [presence, mode, isResting, reducedMotion, breath])

  // Hearing echo — scale from the REAL audio level, never simulated.
  // Only when the activity says the user is speaking (real VAD).
  // Reduced-motion: no animated scale — a static wider ring at real level.
  useEffect(() => {
    if (activity !== "hearing") {
      echo.setValue(0)
      return
    }
    if (reducedMotion) {
      echo.setValue(Math.min(1, audioLevel * 1.6))
      return
    }
    Animated.timing(echo, {
      toValue: Math.min(1, audioLevel * 1.6),
      duration: 90,
      useNativeDriver: true,
    }).start()
  }, [activity, audioLevel, reducedMotion, echo])

  // ── Speaking ring (F5c, UX §2.4/§3.1: "anillo índigo animado con el
  // nivel real de playback; el avatar crece un 8%") ──────────────────────────
  // While the agent's TTS sounds, an indigo ring scales with the REAL
  // playback level (the same audioLevel chain: ttsPlayer analyser → RAF
  // poll → setAudioLevel) and the body grows up to 8% (protagonismo —
  // who speaks is unmistakable: their face, larger). NEVER simulated
  // (AC-UX2): the ring only exists while real playback exists.
  // Reduced-motion: static ring at the real level, no animation.
  // F5c: only (re)start a timing when the target actually moved — at 60fps
  // audioLevel changes, starting a new Animated.timing every effect run
  // piles up animations and churns the JS thread. The running timing eases
  // toward the new target anyway (same visual, far less work).
  const speakTargetRef = useRef(-1)
  useEffect(() => {
    if (activity !== "speaking") {
      if (speakTargetRef.current !== 0) {
        speakTargetRef.current = 0
        speak.setValue(0)
      }
      return
    }
    const target = Math.min(1, audioLevel * 1.6)
    if (Math.abs(target - speakTargetRef.current) < 0.004) return
    speakTargetRef.current = target
    if (reducedMotion) {
      speak.setValue(target)
      return
    }
    Animated.timing(speak, {
      toValue: target,
      duration: 90,
      useNativeDriver: true,
    }).start()
  }, [activity, audioLevel, reducedMotion, speak])

  // Recognition flash — fires when hearing begins (the invocation was
  // accepted): a 300ms indigo pop (§3.1 "flash de reconocimiento").
  // Reduced-motion: no pop — the state change itself is the signal.
  const prevActivity = useRef<VoiceActivity>("idle")
  useEffect(() => {
    if (activity === "hearing" && prevActivity.current !== "hearing") {
      setFlashKey((k) => k + 1)
      if (!reducedMotion) {
        Animated.sequence([
          Animated.timing(flash, { toValue: 1, duration: 150, useNativeDriver: true }),
          Animated.timing(flash, { toValue: 0, duration: 300, useNativeDriver: true }),
        ]).start()
      }
    }
    prevActivity.current = activity
  }, [activity, reducedMotion, flash])

  // ── Halo color: presence first, then mode ──
  // conversation reads the THEME accent (violet on both sheets); passive the
  // neutral; MODE_COLORS stays the static language for non-themed readers.
  const haloColor =
    presence === "error"
      ? colors.red
      : presence === "connecting"
        ? c.text3
        : mode === "conversation"
          ? c.accent
          : MODE_COLORS[mode]

  // Breathing opacity range — passive breathes fainter (UX §3.2: opacidad ~0.6);
  // resting breathes one step fainter still (§3.2 "se atenúa un paso más").
  const breathOpacity = breath.interpolate({
    inputRange: [0, 1],
    outputRange: isResting ? [0.15, 0.3] : mode === "passive" ? [0.25, 0.5] : [0.35, 0.75],
  })
  const breathScale = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [1, mode === "conversation" ? 1.06 : 1.04],
  })

  // Echo ring — a second, wider halo that scales with real audio.
  const echoScale = echo.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] })
  const echoOpacity = echo.interpolate({ inputRange: [0, 1], outputRange: [0, 0.4] })

  // Speaking ring (F5c) — indigo, scales with the REAL TTS playback level.
  // Wider than the echo (the agent's voice is the room's protagonist) and
  // the body grows with it (protagonismo, UX §3.1: "el avatar crece un 8%").
  const speakScale = speak.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] })
  const speakOpacity = speak.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] })
  const speakBodyScale = speak.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] })

  // Flash ring — recognition pop.
  const flashScale = flash.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5] })
  const flashOpacity = flash.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] })

  // Activity accents (§3.1 table):
  //   thinking / waiting_worker / reconnecting → amber border on the body
  //   (no waveform, no theatre — AC-UX2)
  const isThinking = activity === "thinking"
  const isWaitingWorker = activity === "waiting_worker"
  const isReconnecting = activity === "reconnecting"
  const showAmberAccent = isThinking || isWaitingWorker || isReconnecting

  const ModeIcon = MODE_ICONS[mode]

  const activityLabel = getActivityLabel({ activity, workerName, reconnectAttempt, t })
  // The full state as TEXT (UX §11.2: state is never color/animation-only):
  // agent — activity — resting. Resting is announced, not just faded.
  // Composed from i18n'd parts (activityLabel, voice.orb.resting) — the
  // agent name is a proper noun. NB: `voice.orb.label` in the locales is a
  // "{{agent}} presence" template that would DROP the activity/resting
  // state — the a11y label must be the full composed state, so the locale
  // key is not used here.
  const orbLabel = [
    agentName ?? "Alice",
    activityLabel,
    isResting ? t("voice.orb.resting", { defaultValue: "en reposo" }) : null,
  ]
    .filter(Boolean)
    .join(" — ")

  return (
    <Popover placement="top-end" offset={8}>
      <Popover.Trigger asChild>
        <Pressable accessibilityLabel={orbLabel} accessibilityRole="button" hitSlop={10}>
          <RNView
            style={{
              width: ORB_SIZE,
              height: ORB_SIZE,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* Echo ring — real audio only (AC-UX2) */}
            {activity === "hearing" && (
              <Animated.View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  width: ORB_SIZE,
                  height: ORB_SIZE,
                  borderRadius: ORB_SIZE / 2,
                  borderWidth: 2,
                  borderColor: colors.green,
                  transform: [{ scale: echoScale }],
                  opacity: echoOpacity,
                }}
              />
            )}

            {/* Speaking ring (F5c) — REAL TTS playback only (AC-UX2):
                indigo ring scaling with the agent's actual voice level.
                The "wow-wow" — synced to what the user HEARS, never simulated. */}
            {activity === "speaking" && (
              <Animated.View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  width: ORB_SIZE,
                  height: ORB_SIZE,
                  borderRadius: ORB_SIZE / 2,
                  borderWidth: 2.5,
                  borderColor: c.accent,
                  transform: [{ scale: speakScale }],
                  opacity: speakOpacity,
                }}
              />
            )}

            {/* Recognition flash ring */}
            <Animated.View
              key={flashKey}
              pointerEvents="none"
              style={{
                position: "absolute",
                width: ORB_SIZE,
                height: ORB_SIZE,
                borderRadius: ORB_SIZE / 2,
                borderWidth: 2,
                borderColor: c.accent,
                transform: [{ scale: flashScale }],
                opacity: flashOpacity,
              }}
            />

            {/* Breathing halo — color = presence+mode */}
            <Animated.View
              pointerEvents="none"
              style={{
                position: "absolute",
                width: ORB_SIZE,
                height: ORB_SIZE,
                borderRadius: ORB_SIZE / 2,
                borderWidth: 2,
                borderColor: haloColor,
                opacity: breathOpacity,
                transform: [{ scale: breathScale }],
              }}
            />

            {/* The body — avatar or initial. While speaking (F5c, UX §3.1
                "protagonismo") the body grows up to 8% with the REAL TTS
                level — who speaks is unmistakable: their face, larger. */}
            <Animated.View
              style={{
                width: ORB_SIZE - 10,
                height: ORB_SIZE - 10,
                borderRadius: (ORB_SIZE - 10) / 2,
                overflow: "hidden",
                backgroundColor: c.bgStep,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: showAmberAccent ? 2 : 0,
                borderColor: colors.amber,
                transform: activity === "speaking" ? [{ scale: speakBodyScale }] : undefined,
              }}
            >
              {agentAvatarUrl ? (
                <Image
                  source={{ uri: agentAvatarUrl }}
                  style={{ width: ORB_SIZE - 10, height: ORB_SIZE - 10 }}
                  resizeMode="cover"
                />
              ) : (
                <T step="hsm" tone="text2">
                  {(agentName ?? "A").charAt(0).toUpperCase()}
                </T>
              )}
            </Animated.View>

            {/* Badges — moon (passive) / alert (error) */}
            {presence !== "error" && mode === "passive" && (
              <RNView
                style={{
                  position: "absolute",
                  top: -2,
                  right: -2,
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  backgroundColor: c.bgStep,
                  borderWidth: 1,
                  borderColor: c.border,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ph name={ModeIcon} size={9} color={c.text3} />
              </RNView>
            )}
            {presence === "error" && (
              <RNView
                style={{
                  position: "absolute",
                  top: -2,
                  right: -2,
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  backgroundColor: colors.red,
                  borderWidth: 1,
                  borderColor: c.bgStep,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ph name="warning" size={9} color={colors.main100} weight="bold" />
              </RNView>
            )}
          </RNView>
        </Pressable>
      </Popover.Trigger>

      {/* ── Popover: mode + ¿qué has oído? + hang up (a `.menu` card) ── */}
      <Popover.Content
        backgroundColor={c.bgStep}
        borderWidth={1}
        borderColor={c.border}
        borderRadius={16}
        padding={6}
        animation="quick"
        enterStyle={{ opacity: 0, y: 6 }}
        exitStyle={{ opacity: 0, y: 6 }}
        maxWidth={300}
        style={Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : undefined}
      >
        <RNView style={{ gap: 2, minWidth: 230 }}>
          {/* Header: agent + activity */}
          <RNView
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 10,
              paddingTop: 6,
              paddingBottom: 6,
            }}
          >
            <Dot color={haloColor} size={8} />
            <T step="sm" numberOfLines={1} style={{ flex: 1 }}>
              {agentName ?? t("voice.orb.agent", { defaultValue: "Alice" })}
            </T>
            {activityLabel ? (
              <T step="12" tone="text3" numberOfLines={1}>
                {activityLabel}
              </T>
            ) : null}
          </RNView>

          {/* ¿Qué has oído? — last heard phrase (§3.1) */}
          {lastHeard && (
            <RNView
              style={{
                gap: 2,
                paddingVertical: 8,
                paddingHorizontal: 10,
                borderRadius: 10,
                backgroundColor: c.nest,
                marginHorizontal: 2,
                marginBottom: 2,
              }}
            >
              <T step="codenote" tone="text3">
                {t("voice.orb.lastHeard", { defaultValue: "¿Qué has oído?" })}
              </T>
              <T step="12" tone="text2" numberOfLines={2}>
                “{lastHeard}”
              </T>
            </RNView>
          )}

          {/* Mode — same ModePicker as the bar (same ceremony) */}
          <MenuSection>{t("voice.mode.title", { defaultValue: "Modo" })}</MenuSection>
          <ModePicker mode={mode} onSelect={onSetMode} />

          <RNView
            style={{ height: 1, backgroundColor: c.border, marginVertical: 6, marginHorizontal: 4 }}
          />

          {/* Mute (F5c) — the mic's door, in the same popover as mode and
              hang up. The orb popover is the single control surface of the
              v2 path; this row only renders when the caller wires it. */}
          {onToggleMute && (
            <MenuRow
              icon={isMuted ? "microphone-slash" : "microphone"}
              danger={!!isMuted}
              label={
                isMuted
                  ? t("voice.orb.unmute", { defaultValue: "Activar micrófono" })
                  : t("voice.orb.mute", { defaultValue: "Silenciar micrófono" })
              }
              onPress={onToggleMute}
            />
          )}

          {/* Jump back to the conversation (Pablo, 2026-10-05) — the orb
              floats over the whole app; this door takes you back to the
              chat the voice session belongs to. */}
          {onJumpToConversation && (
            <MenuRow
              icon="chat-circle"
              label={t("voice.orb.jumpToConversation", { defaultValue: "Ir a la conversación" })}
              onPress={onJumpToConversation}
            />
          )}

          {/* Hang up */}
          <MenuRow
            icon="phone-x"
            danger
            label={t("voice.orb.hangUp", { defaultValue: "Colgar" })}
            onPress={onDisconnect}
          />
        </RNView>
      </Popover.Content>
    </Popover>
  )
}

// ─── Activity label (shared with the bar — UX §2.7 priority order) ────────────

export function getActivityLabel({
  activity,
  workerName,
  reconnectAttempt,
  t,
}: {
  activity: VoiceActivity
  workerName?: string | null
  reconnectAttempt?: number
  t: (key: string, opts?: any) => string
}): string {
  switch (activity) {
    case "hearing":
      return t("voice.activity.hearing", { defaultValue: "Escuchando" })
    case "thinking":
      return t("voice.activity.thinking", { defaultValue: "Pensando…" })
    case "speaking":
      return t("voice.activity.speaking", { defaultValue: "Hablando" })
    case "waiting_worker":
      return workerName
        ? t("voice.activity.waitingWorker", {
            defaultValue: "{{name}} está trabajando",
            name: workerName,
          })
        : t("voice.activity.thinking", { defaultValue: "Pensando…" })
    case "reconnecting":
      return t("voice.activity.reconnecting", {
        defaultValue: "Reconectando… intento {{n}}/5",
        // The locale templates interpolate {{attempt}} (es "Reconectando
        // ({{attempt}})...", en "Reconnecting ({{attempt}})...") — pass BOTH
        // so the number renders whichever template wins.
        n: reconnectAttempt ?? 1,
        attempt: reconnectAttempt ?? 1,
      })
    case "idle":
    default:
      return ""
  }
}
