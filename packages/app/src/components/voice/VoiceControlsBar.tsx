/**
 * VoiceControlsBar — the bloom's ACTION bar (F5c, ui-evolution §2.5.2) ⭐
 *
 * THE UNIFICATION (Pablo's "dos interfaces" feedback, 2026-10-03):
 * the old bloom swapped the composer for VoiceControls — a SECOND state
 * grammar (dot + label + waveform mini) parallel to the orb's (halo +
 * echo + speaking ring). Two interfaces painting the same state.
 *
 * This bar is the fix: it carries DOORS, not state. Three actions and
 * nothing else — mute, mode, hang up. The STATE lives in the orb, which
 * never disappears while presence is on:
 *   halo   → presence + mode
 *   echo   → your REAL voice (hearing)
 *   ring   → Alice's REAL TTS volume (speaking — the "wow-wow")
 *
 * Where it lives: mounted by ChatView ABOVE the InputComposer (which
 * stays — voice-notes are a legitimate, unchanged feature), only while
 * bloomed, only in the v2 path (voice.mode-ui flag on). The composer
 * swap of the legacy path is untouched (zero regression).
 *
 * Anatomy (OS prototype vocabulary): a card on the sheet (radius 16,
 * one step off, violet lift) holding
 *   [mute · IconBtn] [mode · Segmented: Conversación | En escucha] [Colgar · Btn danger]
 * — the same three doors the orb's popover carries, at surface size.
 */

import React from "react"
import { useTranslation } from "react-i18next"
import { Platform, View } from "react-native"
import type { VoiceMode } from "@teros/shared"
import { useColors } from "../mca/primitives/useColors"
import { Btn, IconBtn, Segmented } from "../ui/ds"
import { getModeOptions, MODE_ICONS } from "./ModePicker"

// ─── Props ───────────────────────────────────────────────────────────────────

export interface VoiceControlsBarProps {
  /** Current mode (the segmented control's active item). */
  mode: VoiceMode
  /** Mic mute state (the mute button's icon + color). */
  isMuted: boolean
  /** Selects a mode → set_mode frame. */
  onSetMode: (mode: VoiceMode) => void
  /** Mute/unmute the mic. */
  onToggleMute: () => void
  /** Hang up (stopSession). */
  onDisconnect: () => void
}

// ─── The bar ─────────────────────────────────────────────────────────────────

export function VoiceControlsBar({
  mode,
  isMuted,
  onSetMode,
  onToggleMute,
  onDisconnect,
}: VoiceControlsBarProps) {
  const { t } = useTranslation()
  const c = useColors()

  const modeItems = getModeOptions(t).map((o) => ({
    key: o.id,
    label: o.label,
    icon: MODE_ICONS[o.id],
  }))

  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 16,
          backgroundColor: c.bgStep,
        },
        Platform.OS === "web" ? ({ boxShadow: c.liftSm } as any) : null,
      ]}
    >
      {/* Mute — the mic's door. Red when muted (the one functional color). */}
      <IconBtn
        icon={isMuted ? "microphone-slash" : "microphone"}
        danger={isMuted}
        on={false}
        onPress={onToggleMute}
        hitSlop={4}
        style={isMuted ? { backgroundColor: c.tint.r.bg, borderColor: c.tint.r.bd } : undefined}
        accessibilityLabel={
          isMuted
            ? t("voice.orb.unmute", { defaultValue: "Activar micrófono" })
            : t("voice.orb.mute", { defaultValue: "Silenciar micrófono" })
        }
        title={
          isMuted
            ? t("voice.orb.unmute", { defaultValue: "Activar micrófono" })
            : t("voice.orb.mute", { defaultValue: "Silenciar micrófono" })
        }
      />

      {/* Mode — the mode axis' door (UX §3.5): both modes visible, icon +
          label together, the current one lifted. Same setMode as the orb's
          ModePicker (same ceremony). */}
      <View
        accessibilityLabel={t("voice.mode.title", { defaultValue: "Modo" })}
        accessibilityRole={Platform.OS === "web" ? ("tablist" as any) : undefined}
      >
        <Segmented<VoiceMode> items={modeItems} value={mode} onChange={onSetMode} />
      </View>

      {/* Hang up — the exit door. Red: it ends the presence. */}
      <Btn
        variant="danger"
        icon="phone-x"
        onPress={onDisconnect}
        hitSlop={4}
        accessibilityLabel={t("voice.orb.hangUp", { defaultValue: "Colgar" })}
      >
        {t("voice.orb.hangUp", { defaultValue: "Colgar" })}
      </Btn>
    </View>
  )
}
