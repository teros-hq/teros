/**
 * PresenceDivider — el recibo de presencia (ui-evolution.md §3.5) ⭐
 *
 * Divisor de tramo de voz en el hilo:
 *   - Al activar presencia:  "Alice conectada · 13:25 · modo conversation"
 *     (UC-11 — el ritual de encendido deja marca en el hilo).
 *   - Al colgar: el divider se CIERRA con la duración real —
 *     "Alice conectada 9:12–14:03 · 4h 51m" (UX §5.5, el recibo de
 *     presencia). Apagar no es perder la llamada: es despedir a alguien
 *     que estuvo ahí — el recibo lo hace tangible.
 *   - Si murió por error: "· interrumpida" en lugar de la duración.
 *
 * Look (OS prototype): the section-label grammar — dot · UPPERCASE · hairline.
 * Mint while the session LIVES ("you are here"), text3 once it is a receipt.
 *
 * Gated by the voice.mode-ui feature flag (mounted only by v2 surfaces).
 */

import React from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { getDateLocale } from "../../i18n"
import { colors } from "../mca/primitives/colors"
import { useColors } from "../mca/primitives/useColors"
import { Dot, T } from "../ui/ds"
import type { VoiceMode } from "@teros/shared"

// ─── Duration formatting (the receipt's core) ─────────────────────────────────

/**
 * Format a session duration in human terms — "4h 51m", "12 m", "45 s".
 * The receipt reads like a person, not a stopwatch.
 */
export function formatSessionDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// ─── Props ───────────────────────────────────────────────────────────────────

export interface PresenceDividerProps {
  /** Agent display name ("Alice"). */
  agentName?: string
  /** The mode the session started in — shown on the opening divider (UC-11). */
  mode?: VoiceMode
  /** When the voice presence started. */
  startedAt: Date | number
  /**
   * When the presence ended. When undefined the session is LIVE — the
   * divider renders in its opening form ("Alice conectada · 13:25").
   */
  endedAt?: Date | number | null
  /** True when the session died from an error — the receipt says "interrumpida". */
  interrupted?: boolean
}

export function PresenceDivider({
  agentName,
  mode,
  startedAt,
  endedAt,
  interrupted = false,
}: PresenceDividerProps) {
  const { t } = useTranslation()
  const c = useColors()

  const start = startedAt instanceof Date ? startedAt : new Date(startedAt)
  const timeString = start.toLocaleTimeString(getDateLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  })

  const isClosed = endedAt != null
  const end = isClosed ? (endedAt instanceof Date ? endedAt : new Date(endedAt)) : null
  const endTimeString = end
    ? end.toLocaleTimeString(getDateLocale(), { hour: "2-digit", minute: "2-digit" })
    : null
  const duration =
    end != null ? formatSessionDuration((end.getTime() - start.getTime()) / 1000) : null

  const name = agentName ?? t("voice.orb.agent", { defaultValue: "Alice" })

  // The divider's accent: mint while the session lives ("live" tone of the
  // language), text3 once it's a receipt. Interrupted receipts keep the
  // neutral — the word says how it ended.
  const live = !isClosed
  const accent = live ? c.tint.m.tx : c.text3
  const dotColor = live ? colors.mint300 : c.text3

  // Label:
  //   open   → "Alice conectada · 13:25 · modo conversation"
  //   closed → "Alice conectada 9:12–14:03 · 4h 51m"   (the receipt)
  //   broken → "Alice conectada 9:12–14:03 · interrumpida"
  let label: string
  if (!isClosed || endTimeString == null) {
    const modeLabel = mode ? t(`voice.mode.${mode}`, { defaultValue: mode }) : null
    label = t("voice.divider.open", {
      defaultValue: "{{name}} conectada · {{time}}",
      name,
      time: timeString,
    })
    if (modeLabel) {
      label += ` · ${t("voice.divider.mode", { defaultValue: "modo" })} ${modeLabel.toLowerCase()}`
    }
  } else {
    label = t("voice.divider.closed", {
      defaultValue: "{{name}} conectada {{start}}–{{end}}",
      name,
      start: timeString,
      end: endTimeString,
    })
    label +=
      interrupted || duration == null
        ? ` · ${t("voice.divider.interrupted", { defaultValue: "interrumpida" })}`
        : ` · ${duration}`
  }

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        width: "100%",
        paddingVertical: 6,
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: c.border }} />
      <Dot color={dotColor} size={6} />
      <T
        step="xs"
        color={accent}
        numberOfLines={1}
        center
        style={{ maxWidth: "85%", flexShrink: 1 }}
      >
        {label}
      </T>
      <View style={{ flex: 1, height: 1, backgroundColor: c.border }} />
    </View>
  )
}
