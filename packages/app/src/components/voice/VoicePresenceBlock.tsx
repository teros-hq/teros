/**
 * VoicePresenceBlock — Alice's presence, anchored in the navbar (PoC 2026-10-31)
 *
 * Pablo: "el bubble que está flotando debería estar en la navbar, justo
 * encima de Pablo Pérez Torres, entre el usuario y los desktops, para que
 * podamos tenerla siempre escuchando independientemente de en qué interfaz
 * estemos". The presence belongs to the PERSON in the workspace, not to a
 * conversation — so it lives next to the person.
 *
 *   off        → dim mic + "Iria · Voz apagada · Activar"; the row starts
 *                the session (super-agent, presence thread) in Disponible.
 *   connecting → "Conectando…".
 *   on         → the PresenceOrb (its popover is the control surface: modes,
 *                mute, jump to the thread, hang up) + name + "Modo · actividad"
 *                + a one-tap mute. Muted reads "Silenciada" — the mute is a
 *                switch over the three modes, not a fourth mode.
 *
 * Collapsed rail: the orb alone (or the dim mic when off).
 * Gated by voice.enabled + voice.mode-ui, like the floating overlay it replaces
 * on desktop.
 */

import React, { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Pressable, View } from "react-native"
import type { VoiceMode } from "@teros/shared"
import { useVoiceSession } from "../../contexts/VoiceSessionContext"
import { useVoicePresence } from "../../hooks/voice/useVoicePresence"
import { getResolvedFlag, useFeatureFlagsStore } from "../../store/featureFlagsStore"
import { useNavbarStore } from "../../store/navbarStore"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { useColors } from "../mca/primitives/useColors"
import { Ph, T } from "../ui/ds"
import { getModeOptions } from "./ModePicker"
import { getActivityLabel, PresenceOrb } from "./PresenceOrb"

/** The mode a presence started from the navbar rests in (Pablo, decision 2). */
const PRESENCE_START_MODE: VoiceMode = "available"

/**
 * The dialogue window made visible (Pablo, PoC 2026-10-31): after a call by
 * name the presence reads "Conversando" for a few seconds and a 2px bar
 * drains; then the block falls back to the resting mode on its own.
 */
function DrainBar({ until, color, track }: { until: number; color: string; track: string }) {
  const [fraction, setFraction] = useState(1)
  useEffect(() => {
    const total = Math.max(1, until - Date.now())
    let raf: ReturnType<typeof setTimeout>
    const tick = () => {
      const left = Math.max(0, until - Date.now())
      setFraction(left / total)
      if (left > 0) raf = setTimeout(tick, 50)
    }
    tick()
    return () => clearTimeout(raf)
  }, [until])
  return (
    <View style={{ height: 2, borderRadius: 1, backgroundColor: track, overflow: "hidden", marginTop: 4 }}>
      <View style={{ height: 2, width: `${Math.round(fraction * 100)}%`, backgroundColor: color }} />
    </View>
  )
}

/** True while `until` is in the future (re-evaluated when it passes). */
function useWindowOpen(until: number | null): boolean {
  const [open, setOpen] = useState(() => until != null && until > Date.now())
  useEffect(() => {
    if (until == null || until <= Date.now()) {
      setOpen(false)
      return
    }
    setOpen(true)
    const id = setTimeout(() => setOpen(false), until - Date.now())
    return () => clearTimeout(id)
  }, [until])
  return open
}

export function VoicePresenceBlock({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation()
  const c = useColors()
  const session = useVoiceSession()
  const { startVoiceFor } = useVoicePresence()
  const flags = useFeatureFlagsStore((s) => s.flags)
  const enabled =
    getResolvedFlag<boolean>({ flags }, "voice.enabled") &&
    getResolvedFlag<boolean>({ flags }, "voice.mode-ui")

  // The face: the session's agent while on; the workspace's super-agent while off.
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const agent = useNavbarStore((s) => {
    if (session.activeAgentId) return s.agents.find((a) => a.agentId === session.activeAgentId)
    return (
      s.agents.find((a) => !a.workspaceId) ??
      s.agents.find((a) => a.workspaceId && a.workspaceId === activeWorkspaceId)
    )
  })
  const agentName = agent?.name ?? t("voice.orb.agent", { defaultValue: "Alice" })

  // Start → Disponible: the mode travels in the connection itself, so the
  // backend opens the session already in it (no first-utterance race). Only
  // starts made from HERE; a chat-started session keeps whatever mode it had.
  const start = useCallback(() => {
    void startVoiceFor(undefined, { initialMode: PRESENCE_START_MODE })
  }, [startVoiceFor])

  const openWindow = useTilingStore((s) => s.openWindow)
  const jumpToConversation = useCallback(() => {
    // Preview routing (preview-tabs.md): a plain click reuses the desktop's
    // preview tab; only ctrl/cmd-click opens a separate tab.
    if (session.channelId) openWindow("chat", { channelId: session.channelId }, false)
  }, [openWindow, session.channelId])

  // Hooks first, early return after — the flags arrive asynchronously, and a
  // hook below the `enabled` return changed the hook count between renders
  // ("Rendered more hooks than during the previous render", 2026-10-31).
  const on = session.presence === "on"
  const connecting = session.presence === "connecting"
  const windowOpen = useWindowOpen(on ? session.dialogueWindowUntil : null)

  if (!enabled) return null
  // While she is answering a call by name (thinking/speaking) or the follow-up
  // window is open, the presence READS as Conversando — temporarily.
  const transientTalking =
    on && session.mode !== "conversation" && (windowOpen || session.activity === "thinking" || session.activity === "speaking")
  const options = getModeOptions(t)
  const modeLabel =
    (transientTalking ? options.find((o) => o.id === "conversation")?.label : null) ??
    options.find((o) => o.id === session.mode)?.label ??
    session.mode
  const activityLabel = getActivityLabel({
    activity: session.activity,
    workerName: session.workerName,
    reconnectAttempt: session.reconnectAttempt,
    t,
  })
  const status = connecting
    ? t("voice.presence.connecting", { defaultValue: "Conectando…" })
    : !on
      ? `${t("voice.mode.off", { defaultValue: "Voz apagada" })} · ${t("voice.presence.turnOn", { defaultValue: "Activar" })}`
      : session.isMuted
        ? t("voice.mode.muted", { defaultValue: "Silenciada" })
        : [modeLabel, activityLabel ?? t("voice.orb.resting", { defaultValue: "en reposo" })].join(" · ")

  const orbSize = collapsed ? 32 : 36

  const orb = on ? (
    <PresenceOrb
      size={orbSize}
      presence={session.presence}
      mode={session.mode}
      activity={session.activity}
      audioLevel={session.audioLevel}
      agentAvatarUrl={agent?.avatarUrl}
      agentName={agent?.name}
      lastHeard={session.lastHeard}
      workerName={session.workerName}
      reconnectAttempt={session.reconnectAttempt}
      onSetMode={session.setMode}
      onToggleMute={session.toggleMute}
      isMuted={session.isMuted}
      onJumpToConversation={jumpToConversation}
      onDisconnect={session.stopSession}
    />
  ) : (
    // Off: a plain disc — the PRESSABLE is the row (expanded) or the disc's
    // wrapper (collapsed); never a button inside a button (RN-web warns).
    <View
      style={{
        width: orbSize,
        height: orbSize,
        borderRadius: orbSize / 2,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.wash,
        alignItems: "center",
        justifyContent: "center",
        opacity: connecting ? 0.6 : 1,
      }}
    >
      <Ph name="microphone" size={15} color={c.text3} />
    </View>
  )

  if (collapsed) {
    return on ? (
      <View style={{ alignItems: "center", paddingBottom: 6 }}>{orb}</View>
    ) : (
      <Pressable
        onPress={start}
        disabled={connecting}
        accessibilityRole="button"
        accessibilityLabel={`${agentName} — ${status}`}
        hitSlop={6}
        style={{ alignItems: "center", paddingBottom: 6 }}
      >
        {orb}
      </Pressable>
    )
  }

  const rowStyle = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 10,
    paddingHorizontal: 4,
    paddingTop: 6,
    paddingBottom: 10,
  }
  const body = (
    <>
      {orb}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T step="sm" numberOfLines={1}>
          {agentName}
        </T>
        <T step="codenote" tone="text3" numberOfLines={1} style={{ textTransform: "none" }}>
          {status}
        </T>
        {windowOpen && session.dialogueWindowUntil != null ? (
          <DrainBar until={session.dialogueWindowUntil} color={c.accent} track={c.border} />
        ) : null}
      </View>
      {on ? (
        <Pressable
          onPress={session.toggleMute}
          accessibilityRole="button"
          accessibilityLabel={
            session.isMuted
              ? t("voice.orb.unmute", { defaultValue: "Activar micrófono" })
              : t("voice.orb.mute", { defaultValue: "Silenciar micrófono" })
          }
          hitSlop={8}
          style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
        >
          <Ph
            name={session.isMuted ? "microphone-slash" : "microphone"}
            size={15}
            color={session.isMuted ? c.tint.r.tx : c.text3}
          />
        </Pressable>
      ) : null}
    </>
  )

  // On: a plain row (the orb and the mute carry their own buttons).
  // Off: the whole row is the start button.
  return on ? (
    <View style={rowStyle} testID="voice-presence-block">
      {body}
    </View>
  ) : (
    <Pressable
      onPress={start}
      disabled={connecting}
      accessibilityRole="button"
      accessibilityLabel={`${agentName} — ${status}`}
      style={rowStyle}
      testID="voice-presence-block"
    >
      {body}
    </Pressable>
  )
}
