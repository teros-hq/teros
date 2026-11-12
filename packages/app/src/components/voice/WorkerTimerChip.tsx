/**
 * WorkerTimerChip — la espera legible (ui-evolution.md §3.8) ⭐
 *
 * Cronómetro vivo mientras el worker trabaja: "Jordan · 12 s" → "1:05".
 * La espera es legible, no un spinner eterno (AC-UX3).
 *
 * Dónde vive: junto al orbe (PresenceOrb popover) y en el campo de estado
 * del bloom (VoiceControls) — y en las filas de delegación del hilo
 * (VoiceThreadSection) mientras el worker más reciente no termina.
 *
 * Look (OS prototype): an amber `Badge` pill — the "working" tone of the
 * language ("the agent is working" is one concept, one colour, everywhere
 * in the OS). The name and the live number share the amber text; the only
 * emphasis is the ticking itself. The inline `ElapsedTimer` (used by the
 * delegation rows) stays plain text: mono, amber, no box.
 *
 * El tiempo corre desde el frame `channel_started` del worker más reciente
 * (el VoiceSessionContext lo expone como `workerStartedAt`). Si no hay
 * timestamp, muestra solo el nombre — nunca un cronómetro falso (AC-UX2:
 * ninguna animación simula lo inexistente; un timer sin origen es teatro).
 *
 * Gated by the voice.mode-ui feature flag (mounted only by v2 surfaces).
 */

import React, { useEffect, useState } from "react"
import { View } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { Badge, T } from "../ui/ds"

/** Update cadence of the live timer — 1 s is enough for a human-readable wait. */
const TICK_MS = 1000

/**
 * Format elapsed seconds as a readable duration:
 *   < 60 s  → "12 s" (the spec's first beat)
 *   ≥ 60 s  → "1:05" (the spec's second beat)
 */
export function formatElapsedSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s < 60) return `${s} s`
  const mins = Math.floor(s / 60)
  const secs = s % 60
  return `${mins}:${secs.toString().padStart(2, "0")}`
}

/**
 * The live elapsed seconds alone — "12 s" ticking, amber, mono. The ticking
 * heart of the chip, exported so the delegation rows can ride the same
 * seconds without duplicating the interval ("Jordan empezó a trabajar ·
 * 12 s"). Renders null without a start time — no fake timer (AC-UX2).
 */
export function ElapsedTimer({ startedAt }: { startedAt?: number | null }) {
  const c = useColors()
  const [, forceTick] = useState(0)

  // Live cronómetro — one tick per second while a start time exists.
  useEffect(() => {
    if (startedAt == null) return
    const id = setInterval(() => forceTick((n) => n + 1), TICK_MS)
    return () => clearInterval(id)
  }, [startedAt])

  const elapsed = startedAt != null ? Math.floor((Date.now() - startedAt) / 1000) : null
  if (elapsed == null) return null

  return (
    <T step="code" color={c.tint.a.tx} style={{ fontVariant: ["tabular-nums"] }}>
      {formatElapsedSeconds(elapsed)}
    </T>
  )
}

export interface WorkerTimerChipProps {
  /** Display name of the working worker ("Jordan"). */
  workerName: string
  /**
   * Epoch ms when the worker started (channel_started frame). When null the
   * chip renders name-only — no fake timer (AC-UX2).
   */
  startedAt?: number | null
  /** Additional workers running in parallel — "+2" (§3.8). */
  parallelCount?: number
}

export function WorkerTimerChip({
  workerName,
  startedAt,
  parallelCount = 0,
}: WorkerTimerChipProps) {
  const c = useColors()

  return (
    <Badge tone="a" pill dot>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}>
        <T step="12" color={c.tint.a.tx} numberOfLines={1} style={{ flexShrink: 1 }}>
          {workerName}
        </T>
        {startedAt != null && (
          <>
            <T step="12" color={c.tint.a.tx} style={{ opacity: 0.7 }}>
              ·
            </T>
            <ElapsedTimer startedAt={startedAt} />
          </>
        )}
        {parallelCount > 0 && (
          <T step="codenote" color={c.tint.a.tx} style={{ opacity: 0.8, flexShrink: 0 }}>
            +{parallelCount}
          </T>
        )}
      </View>
    </Badge>
  )
}
