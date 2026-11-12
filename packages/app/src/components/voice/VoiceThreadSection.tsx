/**
 * VoiceThreadSection — the voice session rendered IN the thread
 * (ui-evolution.md §2.4.4 + §2.5.1) ⭐
 *
 * With the single channel (F0/REQ-2), spoken transcripts are PERSISTED
 * messages of the conversation channel (source:'voice') — they flow through
 * the normal message pipeline and render as normal bubbles with the voice
 * mark. This component renders everything the live WS knows that the
 * persisted history does not:
 *
 *   1. PresenceDivider — the session's opening receipt ("Alice presente ·
 *      13:25 · modo conversation", UC-11). The CLOSING receipt (with the
 *      real duration, UX §5.5) is rendered by ChatView when the session
 *      ends — it needs the start/end stretch, which only ChatView observes
 *      across the presence transition.
 *   2. Delegation rows — channel_event frames (started / finished /
 *      permission / resolved) are NOT persisted by the backend; they only
 *      exist on the live WS. Rendered here as human rows (§2.4.3), with the
 *      live WorkerTimerChip while the worker is still working (§3.8,
 *      AC-UX3 — the wait is readable, not an eternal spinner).
 *   3. Overheard rows — the LIVE overheard utterances (REQ-9, decisión #5
 *      de Pablo). Persisted ones arrive as messages with source:'voice' +
 *      overheard:true (routed to OverheardRow by MessageBubble); the LIVE
 *      ones only exist here. Until F2b lands, a flag-gated dev mock marks
 *      passive user speech as overheard in the context (the
 *      exact semantics the native loop will send).
 *
 * Where it lives: mounted by ChatView as a synthetic item at the newest end
 * of the inverted FlatList (the visual bottom of the thread — the voice
 * session is the live tail of the conversation, UX §8.2), only when the
 * voice session belongs to THIS channel and the v2 flag is on.
 *
 * Gated by the voice.mode-ui feature flag — off = nothing renders and the
 * thread is text + persisted voice messages only (zero regression).
 */

import React from "react"
import { Platform, Pressable, View } from "react-native"
import type { VoiceTranscript } from "@teros/shared"
import { useVoiceSession } from "../../contexts/VoiceSessionContext"
import { useTilingStore } from "../../store/tilingStore"
import { useColors } from "../mca/primitives/useColors"
import { useTranslation } from "react-i18next"
import { getDateLocale } from "../../i18n"
import { Ph, T } from "../ui/ds"
import { PresenceDivider } from "./PresenceDivider"
import { ElapsedTimer } from "./WorkerTimerChip"

// ─── Interim row (F5e — the user's words flowing live) ────────────────────────

/**
 * The LIVE interim STT phrase — the user's words appearing as they speak
 * (F5e, Pablo's "ver SU texto fluyendo en vivo"). Same tenue language as
 * OverheardRow (§3.4): text3 italic, no box, no border — it is not a said
 * thing yet, it is a being-said thing. Each interim replaces the last (the
 * context guarantees ONE at a time); the final consolidates it into the
 * thread as a real row. The trailing ellipsis is the only "live" signal —
 * quiet, not blinking.
 *
 * Exported for its render test (the section mounts it from the session's
 * interimTranscript).
 */
export function InterimRow({ text }: { text: string }) {
  const { t } = useTranslation()
  return (
    <View style={{ alignSelf: "flex-start", maxWidth: "85%", gap: 2, opacity: 0.85 }}>
      <T step="sm" tone="text3" style={{ fontStyle: "italic" }}>
        {text}
        <T step="sm" tone="text3" style={{ fontStyle: "italic", opacity: 0.7 }}>
          {" "}
          {t("voice.interim.ellipsis", { defaultValue: "…" })}
        </T>
      </T>
      <T step="codenote" tone="text3" style={{ textTransform: "none", opacity: 0.85 }}>
        {t("voice.interim.meta", { defaultValue: "hablando…" })}
      </T>
    </View>
  )
}

// ─── Delegation row (UX §9 — "Jordan empezó a trabajar") ─────────────────────

/**
 * Human labels for the channel_event frames. The old TranscriptDisplay rows
 * were English/technical ("Jordan started working"); v2 speaks like a person
 * (ui-evolution §2.4.3). The Approve button keeps its exact behavior: it
 * opens the worker's channel in a window.
 *
 * Densidad (feedback de Pablo, 20:20): una línea de texto plano, sin caja,
 * sin borde, sin color de fondo — la delegación se lee como una acotación
 * de la conversación, no como un panel. El único color es funcional: el
 * cronómetro vivo (ámbar, "corriendo ahora") y el enlace Aprobar (accent,
 * acción real). granted/denied van en texto plano — las palabras dicen
 * lo que pasó; el color no tiene que repetirlo.
 */
function DelegationRow({
  event,
  timestamp,
  workerName,
  workerStartedAt,
}: {
  event: NonNullable<VoiceTranscript["channelEvent"]>
  timestamp: number
  /** Current live worker name (from the session context) — drives the timer. */
  workerName?: string | null
  /** When the live worker started (channel_started) — drives the timer. */
  workerStartedAt?: number | null
}) {
  const { t } = useTranslation()
  const c = useColors()
  const openWindow = useTilingStore((s) => s.openWindow)
  const { eventType, observedChannelId, observedChannelName, toolName, resolution } = event
  const shortTool = toolName ? String(toolName).split("_").pop() : "tool"
  const name = observedChannelName || observedChannelId || "worker"

  const timeString = new Date(timestamp).toLocaleTimeString(getDateLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  })

  const isStarted = eventType === "channel_started"
  const isFinished = eventType === "channel_finished"
  const isPermission = eventType === "channel_permission"
  const isResolved = eventType === "channel_resolved"
  const granted = resolution === "granted"

  const label = isStarted
    ? t("voice.delegation.started", { defaultValue: "{{name}} empezó a trabajar", name })
    : isFinished
      ? t("voice.delegation.finished", { defaultValue: "{{name}} terminó", name })
      : isPermission
        ? t("voice.delegation.permission", {
            defaultValue: "{{name}} necesita aprobación: {{tool}}",
            name,
            tool: shortTool,
          })
        : isResolved
          ? granted
            ? t("voice.delegation.granted", {
                defaultValue: "aprobado · {{tool}}",
                tool: shortTool,
              })
            : t("voice.delegation.denied", { defaultValue: "denegado · {{tool}}", tool: shortTool })
          : ""

  // The live timer rides the STARTED row of the CURRENT worker only — a
  // finished worker shows its row without a timer (AC-UX3).
  const isCurrentWorkerRow =
    isStarted && !!workerName && name.toLowerCase() === String(workerName).toLowerCase()

  return (
    <View style={{ alignItems: "center", paddingVertical: 2, maxWidth: "92%", gap: 2 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          flexShrink: 1,
          maxWidth: "100%",
        }}
      >
        {label ? (
          <T step="12" tone="text2" numberOfLines={2} style={{ flexShrink: 1 }}>
            {label}
          </T>
        ) : null}
        {/* The live wait, inline — "Jordan empezó a trabajar · 12 s" */}
        {isCurrentWorkerRow && <ElapsedTimer startedAt={workerStartedAt ?? null} />}
        {/* Timestamp inline for the rows that are already past — the live
            rows don't need it: the ticking timer IS the time signal. */}
        {!isCurrentWorkerRow && (
          <T step="codenote" tone="text3" style={{ textTransform: "none", flexShrink: 0 }}>
            · {timeString}
          </T>
        )}
      </View>
      {/* Approve — a real action, so it earns the one interactive accent:
          quiet accent text, same size, no box. Opens the worker's window. */}
      {isPermission && observedChannelId && (
        <Pressable
          accessibilityRole="button"
          onPress={() => openWindow("chat", { channelId: observedChannelId }, false)}
          style={[
            { flexDirection: "row", alignItems: "center", gap: 4 },
            Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
          ]}
        >
          <T step="12" tone="accent">
            {t("voice.delegation.approve", { defaultValue: "Aprobar" })}
          </T>
          <Ph name="arrow-right" size={12} color={c.accent} />
        </Pressable>
      )}
    </View>
  )
}

// ─── The section ─────────────────────────────────────────────────────────────

export interface VoiceThreadSectionProps {
  /** Agent display name (for the divider receipt). */
  agentName?: string
}

export function VoiceThreadSection({ agentName }: VoiceThreadSectionProps) {
  const session = useVoiceSession()

  // No permission bell here: the chat's own permission chime (usePermissionSound,
  // RE-MI-DO, one per batch — PERMB-REQ-4) already announces the request. The
  // voice earcon rang on top of it as a second chime (PoC, Pablo 2026-10-31).

  // Live transcripts of THIS session — the persisted half already flows
  // through the thread as messages (source:'voice', F0 single channel).
  const live = session.liveTranscripts

  // Delegation events are the only live content worth rendering here; plain
  // speech transcripts AND overheard phrases arrive as persisted messages
  // (overheard ones render as the tenue OverheardRow in MessageBubble — fix
  // 2026-10-05: the live WS frame used to add its OWN overheard row, so every
  // passive-mode phrase appeared TWICE — one live copy up top, one persisted
  // copy in the thread. One phrase, one row: the persisted one).
  const delegationEvents = live.filter((tr) => tr.type === "channel_event" && !!tr.channelEvent)

  // Safety: the section is only mounted by ChatView while the session lives
  // in THIS channel — but never render on a dead session.
  if (session.presence === "off") return null

  return (
    <View style={{ gap: 6, paddingBottom: 8 }}>
      {/* The opening receipt — the ritual of turning presence on leaves a
          mark in the thread (UC-11). */}
      <PresenceDivider
        agentName={agentName}
        mode={session.mode}
        startedAt={session.sessionStartedAt ?? Date.now()}
      />
      {delegationEvents.map((tr) =>
        tr.channelEvent ? (
          <DelegationRow
            key={tr.id}
            event={tr.channelEvent}
            timestamp={tr.timestamp}
            workerName={session.workerName}
            workerStartedAt={session.workerStartedAt}
          />
        ) : null,
      )}
      {/* F5e: the user's words flowing live — the newest thing in the
          thread is the phrase still being said. Replaced by each interim,
          consolidated by the final (which then renders as the normal row). */}
      {session.interimTranscript && <InterimRow text={session.interimTranscript} />}
    </View>
  )
}
