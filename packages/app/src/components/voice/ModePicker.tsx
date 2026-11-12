/**
 * ModePicker — the UI door for the mode axis (ui-evolution.md §3.2)
 *
 * Compact popover with the THREE product modes (Pablo, PoC 2026-10-31,
 * decisions 1-2; "attention" stays gone since 2026-10-05):
 *   available    — "Disponible — responde si la nombras, no guarda nada" (default)
 *   passive      — "Escucha — guarda lo que oye, solo habla si la nombras"
 *   conversation — "Conversando — responde a todo"
 * Silenciada is NOT a mode: it is the mute switch (mic closed, blocks the three).
 *
 * Used in TWO places — the action bar (mode control) and the PresenceOrb
 * popover — same options, same setMode, same ceremony as the voice door
 * (AC-UX8). Selection → voiceSession.setMode() → `set_mode` client frame →
 * backend broadcasts `mode_changed` to every client.
 *
 * Look (OS prototype): `.menu` rows — radius 10, wash on hover, nav-active +
 * accent + check when selected; Phosphor glyphs; weight 400 everywhere.
 *
 * NEVER hidden cycles or secret long-presses (UX §3.5) — icon + label +
 * description always travel together (UX §11.2).
 */

import React from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { colors } from "../mca/primitives/colors"
import type { VoiceMode } from "@teros/shared"
import { MenuRow } from "./MenuRow"

// ─── Mode visual language (UX §3.2 — icon + color always together) ───────────

/** Phosphor glyph per mode (`<Ph name={MODE_ICONS[mode]} />`). */
export const MODE_ICONS: Record<VoiceMode, string> = {
  available: "circle-dashed", // disponible — ahí, sin guardar nada
  passive: "moon", // luna — escucha, guarda el contexto
  conversation: "chat-circle", // burbujas — responde a todo
}

export const MODE_COLORS: Record<VoiceMode, string> = {
  available: colors.main500, // the DS neutral — resting
  passive: colors.main500, // desaturado — the DS neutral (badge de luna)
  conversation: colors.purple200, // the accent, readable on both sheets
}

/** The modes in UI order (resting → most present). */
export const MODE_ORDER: VoiceMode[] = ["available", "passive", "conversation"]

export interface ModeOption {
  id: VoiceMode
  label: string
  description: string
}

/** The i18n'd options — shared by the picker and the bar's segmented control. */
export function getModeOptions(t: (key: string, opts?: any) => string): ModeOption[] {
  return [
    {
      id: "available",
      label: t("voice.mode.available", { defaultValue: "Disponible" }),
      description: t("voice.mode.availableDescription", { defaultValue: "Responde si la nombras, no guarda nada" }),
    },
    {
      id: "passive",
      label: t("voice.mode.passive", { defaultValue: "Escucha" }),
      description: t("voice.mode.passiveDescription", { defaultValue: "Guarda lo que oye, solo habla si la nombras" }),
    },
    {
      id: "conversation",
      label: t("voice.mode.conversation", { defaultValue: "Conversando" }),
      description: t("voice.mode.conversationDescription", { defaultValue: "Responde a todo" }),
    },
  ]
}

// ─── Props ───────────────────────────────────────────────────────────────────

export interface ModePickerProps {
  /** Current mode (from the context — authoritative via mode_changed). */
  mode: VoiceMode
  /** Selects a mode → set_mode frame → mode_changed broadcast. */
  onSelect: (mode: VoiceMode) => void
}

// ─── The picker (popover content — mount inside a Popover.Content) ───────────

export function ModePicker({ mode, onSelect }: ModePickerProps) {
  const { t } = useTranslation()
  const options = getModeOptions(t)

  return (
    <View style={{ gap: 2, minWidth: 230 }}>
      {options.map(({ id, label, description }) => (
        <MenuRow
          key={id}
          icon={MODE_ICONS[id]}
          label={label}
          description={description}
          on={mode === id}
          onPress={() => onSelect(id)}
        />
      ))}
    </View>
  )
}
