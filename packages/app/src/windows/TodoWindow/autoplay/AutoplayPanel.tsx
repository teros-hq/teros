/**
 * To Do autoplay (TODOAP-REQ-12): the "Autoplay · n" chip of the window header
 * and the runner panel it opens — the board's AutoplayPanel structure
 * (BoardWindow/AutoplayPanel.tsx) drawn with the To Do kit: one card per
 * runner (avatar, name, Working / Waiting for tasks / Paused, active/slots in
 * progress, −/+ slots, the play disc, remove), "Add runner" listing the
 * workspace agents that are not runners yet, and the footer. Each card also
 * carries the runner's scope control (TODOAP-REQ-22): *Also picks up:* and one
 * menu chip (Nothing / planned for today in any branch / in one group). The panel is a
 * 320-wide overlay at the right edge of the window, below the header row,
 * over either view; the chip toggles it, Esc or × closes it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, ScrollView, View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { useAppSlice } from "../data/todoStore"
import { usePeople, type Person } from "../data/usePeople"
import type { TreeNode } from "../model/types"
import { PersonAvatar } from "../node/AssignChip"
import { Btn, Dot, IconBtn, MenuBox, MenuHead, Tx, useDismiss } from "../ui/kit"
import { tdx, web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"
import {
  addRunner,
  loadAutoplay,
  playingCount,
  removeRunner,
  type Runner,
  setGlobalPlay,
  setRunnerPlay,
  setRunnerScope,
  setRunnerSlots,
  stopAutoplay,
  useAutoplaySlice,
  useAutoplayStore,
} from "./autoplayStore"

export const AUTOPLAY_PANEL_WIDTH = 320
/** The auto-wake cap shown in the footer (backend `autoplay.autoWakeCap`, the board's value). */
export const AUTO_WAKE_CAP = 5

const panelKey = (windowId: string | undefined, appId: string) => `${windowId ?? ""}:${appId}`

/** One entry of the scope menu: a group of the tree with its ancestor titles. */
export interface ScopeGroup {
  nodeId: string
  title: string
  /** Ancestor titles, root first (empty for a top-level group). */
  ancestors: string[]
}

/** @spec TODOAP-REQ-22 The tree's groups in tree order, each with its ancestor path. */
export function scopeGroups(nodes: TreeNode[]): ScopeGroup[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const out: ScopeGroup[] = []
  for (const n of nodes) {
    if (n.kind !== "group") continue
    const ancestors: string[] = []
    const seen = new Set<string>([n.nodeId])
    let p = n.parentId ? byId.get(n.parentId) : undefined
    while (p && !seen.has(p.nodeId)) {
      seen.add(p.nodeId)
      ancestors.unshift(p.text)
      p = p.parentId ? byId.get(p.parentId) : undefined
    }
    out.push({ nodeId: n.nodeId, title: n.text, ancestors })
  }
  return out
}

// ─── Chip ───────────────────────────────────────────────────────────────────

/** @spec TODOAP-REQ-12 The window header's "Autoplay · n" chip (n = runners with play on); toggles the panel. */
export function AutoplayChip({
  appId,
  workspaceId,
  windowId,
  compact,
}: {
  appId: string
  workspaceId: string | null
  windowId?: string
  /** Narrow pane: icon + count only. */
  compact?: boolean
}) {
  const td = useTd()
  const { t } = useTranslation()
  const slice = useAutoplaySlice(appId)
  const key = panelKey(windowId, appId)
  const open = useAutoplayStore((s) => !!s.open[key])
  const n = playingCount(slice.runners)

  useEffect(() => {
    void loadAutoplay(appId, workspaceId)
  }, [appId, workspaceId])

  // The chip reads the GLOBAL state first (TODOAP-REQ-30): paused is paused,
  // whatever the runners' config; playing shows how many runners are on.
  const playing = slice.status === "ready" && slice.globalPlaying
  const label = t("todo.autoplay.chip", { count: n })
  return (
    <Pressable
      testID="todo-autoplay-chip"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      onPress={() => useAutoplayStore.getState().setOpen(key, !open)}
      style={({ hovered }: any) => [
        {
          height: 34,
          paddingLeft: 11,
          paddingRight: compact ? 11 : 13,
          borderRadius: 100,
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          flexShrink: 0,
          backgroundColor: open ? td.card : hovered ? td.controlBg : td.wash2,
        },
        web({
          cursor: "pointer",
          boxShadow: open ? td.cardShadow : undefined,
          transition: "background .2s, transform .35s cubic-bezier(.16,1,.3,1)",
        }) as ViewStyle,
      ]}
    >
      <Ph
        name={playing && n > 0 ? "play-circle" : "pause-circle"}
        size={15}
        color={playing && n > 0 ? td.accent : td.text3}
      />
      <Tx s={12} lh={14} c={open ? td.text : td.text2} lines={1}>
        {compact ? String(n) : label}
      </Tx>
    </Pressable>
  )
}

// ─── Panel host (state + data) ──────────────────────────────────────────────

/** @spec TODOAP-REQ-12 Mounts the runner panel of a To Do window while its chip is on. */
export function AutoplayPanelHost({
  appId,
  workspaceId,
  windowId,
  top = 0,
  onError,
}: {
  appId: string
  workspaceId: string | null
  windowId?: string
  /** Where the overlay starts: below the header row, so the chip stays visible and toggles it. */
  top?: number
  onError: (message: string) => void
}) {
  const key = panelKey(windowId, appId)
  const open = useAutoplayStore((s) => !!s.open[key])
  const slice = useAutoplaySlice(appId)
  const { people } = usePeople(workspaceId)
  const nodes = useAppSlice(appId, (s) => s.nodes)
  const groups = useMemo(() => scopeGroups(nodes), [nodes])
  const close = useCallback(() => useAutoplayStore.getState().setOpen(key, false), [key])
  const fail = useCallback((err: unknown) => onError(err instanceof Error ? err.message : String(err)), [onError])

  // While open, a task write (start, running flag, state) can change the
  // in-progress counts: re-read the runners on every todo_node_changed.
  useEffect(() => {
    if (!open) return
    void loadAutoplay(appId, workspaceId)
    const client = getTerosClient()
    let timer: ReturnType<typeof setTimeout> | null = null
    const onNode = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void loadAutoplay(appId, workspaceId), 300)
    }
    client.on("todo_node_changed", onNode)
    return () => {
      if (timer) clearTimeout(timer)
      client.off("todo_node_changed", onNode)
    }
  }, [open, appId, workspaceId])

  if (!open) return null
  return (
    <AutoplayPanel
      runners={slice.runners}
      globalPlaying={slice.status === "ready" ? slice.globalPlaying : true}
      runningCount={slice.runningCount}
      agents={people.filter((p) => p.kind === "agent")}
      onSetSlots={(agentId, slots) => setRunnerSlots(appId, agentId, slots).catch(fail)}
      onSetPlay={(agentId, enabled) => setRunnerPlay(appId, agentId, enabled).catch(fail)}
      onSetGlobalPlay={(playing) => setGlobalPlay(appId, playing).catch(fail)}
      onStopAutoplay={() => stopAutoplay(appId).catch(fail)}
      groups={groups}
      onSetScope={(agentId, scopeNodeId, pickUnassigned) => setRunnerScope(appId, agentId, scopeNodeId, pickUnassigned).catch(fail)}
      onAdd={(p) => addRunner(appId, { agentId: p.id, name: p.name, avatarUrl: p.avatarUrl }).catch(fail)}
      onRemove={(agentId) => removeRunner(appId, agentId).catch(fail)}
      onClose={close}
      top={top}
    />
  )
}

// ─── Panel (presentational) ─────────────────────────────────────────────────

export interface AutoplayPanelProps {
  runners: Runner[]
  /** The workspace's global autoplay play/pause (TODOAP-REQ-30). */
  globalPlaying: boolean
  /** Todo tasks with a live turn — the STOP control's visibility (TODOAP-REQ-31). */
  runningCount: number
  /** The workspace's agents (those already runners are left out of "Add runner"). */
  agents: Person[]
  onSetSlots: (agentId: string, slots: number) => void
  onSetPlay: (agentId: string, enabled: boolean) => void
  /** The global Play/Pause control (TODOAP-REQ-30). */
  onSetGlobalPlay: (playing: boolean) => void
  /** The global STOP: pause + abort the in-flight turns (TODOAP-REQ-31). */
  onStopAutoplay: () => void
  /** The tree's groups, for the scope menu (TODOAP-REQ-22). */
  groups?: ScopeGroup[]
  onSetScope?: (agentId: string, scopeNodeId: string | null, pickUnassigned: boolean) => void
  onAdd: (agent: Person) => void
  onRemove: (agentId: string) => void
  onClose: () => void
  /** Offset of the overlay from the top of the window (the header row's height). */
  top?: number
}

/** @spec TODOAP-REQ-12, TODOAP-REQ-30, TODOAP-REQ-31 The runner panel: the transport row (play/pause/stop), the runner config section, Add runner and the footer. */
export function AutoplayPanel({
  runners,
  globalPlaying,
  runningCount,
  agents,
  onSetSlots,
  onSetPlay,
  onSetGlobalPlay,
  onStopAutoplay,
  groups = [],
  onSetScope = () => {},
  onAdd,
  onRemove,
  onClose,
  top = 0,
}: AutoplayPanelProps) {
  const td = useTd()
  const { t } = useTranslation()
  const [adding, setAdding] = useState(false)
  /** The runner whose scope menu is open. */
  const [scopeMenu, setScopeMenu] = useState<string | null>(null)
  const addRef = useRef<View>(null)
  useDismiss(adding, () => setAdding(false), addRef)

  const candidates = useMemo(() => {
    const ids = new Set(runners.map((r) => r.agentId))
    return agents.filter((a) => !ids.has(a.id))
  }, [agents, runners])

  // Esc closes the panel (an open menu first, through useDismiss).
  const latest = useRef({ adding, scopeMenu, onClose })
  latest.current = { adding, scopeMenu, onClose }
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || latest.current.adding || latest.current.scopeMenu) return
      e.stopPropagation()
      latest.current.onClose()
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [])

  return (
    <View
      testID="todo-autoplay-panel"
      accessibilityRole="none"
      accessibilityLabel={t("todo.autoplay.title")}
      {...tdx("in")}
      style={[
        {
          position: "absolute",
          right: 0,
          top,
          bottom: 0,
          width: AUTOPLAY_PANEL_WIDTH,
          maxWidth: "100%",
          backgroundColor: td.sheet,
          zIndex: 60,
        },
        web({ boxShadow: `${td.elevRaised}, 0 0 0 1px ${td.borderStrong}` }) as ViewStyle,
      ]}
    >
      {/* Head */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingTop: 16, paddingLeft: 18, paddingRight: 10, paddingBottom: 12 }}>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Ph name="play-circle" size={18} color={td.accent} />
            <Tx f="serif" s={22} lh={26} c={td.text}>
              {t("todo.autoplay.title")}
            </Tx>
          </View>
          <Tx f="mono" s={9.5} lh={14} c={td.txs} ls={1} upper>
            {t("todo.autoplay.subtitle")}
          </Tx>
        </View>
        <IconBtn icon="x" label={t("todo.autoplay.close")} color={td.text} iconSize={15} onPress={onClose} />
      </View>

      {/* Transport (TODOAP-REQ-30, TODOAP-REQ-31) — play/pause/stop, the frequent controls */}
      <GlobalPlayRow
        playing={globalPlaying}
        enabledCount={playingCount(runners)}
        runningCount={runningCount}
        onSet={onSetGlobalPlay}
        onStop={onStopAutoplay}
      />

      {/* Runner configuration (TODOAP-REQ-30) — slots + enabled per runner */}
      <View style={{ paddingHorizontal: 18, paddingBottom: 6, paddingTop: 2 }}>
        <Tx f="mono" s={9.5} lh={14} c={td.txs} ls={1} upper>
          {t("todo.autoplay.config")}
        </Tx>
      </View>

      {/* Runners */}
      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 14, gap: 8 }} {...tdx("scroll")}>
        {runners.length === 0 ? (
          <View style={{ borderRadius: 16, backgroundColor: td.step, paddingVertical: 14, paddingHorizontal: 14 }}>
            <Tx s={12.5} lh={18} c={td.text2}>
              {t("todo.autoplay.empty")}
            </Tx>
          </View>
        ) : (
          runners.map((r) => (
            <RunnerCard
              key={r.agentId}
              runner={r}
              globalPlaying={globalPlaying}
              groups={groups}
              menuOpen={scopeMenu === r.agentId}
              onMenu={(open) => setScopeMenu(open ? r.agentId : null)}
              onSetScope={onSetScope}
              onSetSlots={onSetSlots}
              onSetPlay={onSetPlay}
              onRemove={onRemove}
            />
          ))
        )}

        {/* + Add runner */}
        <View ref={addRef} style={{ position: "relative", alignSelf: "flex-start", marginTop: 4, zIndex: 10 }}>
          <Btn sm tone="out" icon="plus" onPress={() => setAdding((v) => !v)}>
            <Tx s={11.5} lh={14} c={td.text}>
              {t("todo.autoplay.add")}
            </Tx>
            <Ph name="caret-down" size={10} color={td.text3} />
          </Btn>
          {adding ? (
            <MenuBox minWidth={220} label={t("todo.autoplay.add")}>
              <MenuHead icon="robot">{t("todo.autoplay.add")}</MenuHead>
              {candidates.length === 0 ? (
                <Tx s={12} lh={16} c={td.txs} style={{ paddingHorizontal: 9, paddingVertical: 8 }}>
                  {t("todo.autoplay.noAgents")}
                </Tx>
              ) : (
                candidates.map((a) => (
                  <Pressable
                    key={a.id}
                    accessibilityRole="menuitem"
                    onPress={() => {
                      setAdding(false)
                      onAdd(a)
                    }}
                    style={({ hovered }: any) => [
                      { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 34, paddingHorizontal: 9, borderRadius: 9, backgroundColor: hovered ? td.wash2 : "transparent" },
                      web({ cursor: "pointer", outlineStyle: "none" }) as ViewStyle,
                    ]}
                  >
                    <PersonAvatar person={a} size={20} />
                    <Tx s={12.5} lh={16} c={td.text} lines={1} style={{ flexShrink: 1 }}>
                      {a.name}
                    </Tx>
                  </Pressable>
                ))
              )}
            </MenuBox>
          ) : null}
        </View>
      </ScrollView>

      {/* Footer */}
      <View style={[{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 16 }, web({ boxShadow: `inset 0 1px 0 ${td.borderStrong}` }) as ViewStyle]}>
        <Tx s={11.5} lh={17} c={td.txs}>
          {`${t("todo.autoplay.footer", { cap: AUTO_WAKE_CAP })} ${t("todo.autoplay.footerScope")}`}
        </Tx>
      </View>
    </View>
  )
}

/**
 * @spec TODOAP-REQ-30, TODOAP-REQ-31 The transport row — the frequent
 * controls in their own section: the big disc (play/pause, one glance says
 * which one you can do), the STOP square (visible ONLY while some task is in
 * flight — runningCount > 0), the state line (Playing · n enabled / Paused)
 * and the hint that a disabled runner stays out. Stop = pause + abort every
 * in-flight turn, the equivalent of stopping each conversation by hand.
 */
function GlobalPlayRow({
  playing,
  enabledCount,
  runningCount,
  onSet,
  onStop,
}: {
  playing: boolean
  /** Runners with play on (the enabled ones — the config section decides). */
  enabledCount: number
  /** Todo tasks with a live turn — the STOP control's visibility (TODOAP-REQ-31). */
  runningCount: number
  onSet: (playing: boolean) => void
  /** The global STOP: pause + abort the in-flight turns (TODOAP-REQ-31). */
  onStop: () => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  return (
    <View
      testID="todo-autoplay-global"
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          marginHorizontal: 12,
          marginBottom: 10,
          borderRadius: 16,
          backgroundColor: td.card,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 12,
          paddingRight: 10,
        },
        web({ boxShadow: td.cardShadow }) as ViewStyle,
      ]}
    >
      <Pressable
        testID="todo-autoplay-global-toggle"
        accessibilityRole="button"
        accessibilityLabel={playing ? t("todo.autoplay.global.pause") : t("todo.autoplay.global.play")}
        accessibilityState={{ checked: playing }}
        onPress={() => onSet(!playing)}
        style={({ hovered, pressed }: any) => [
          {
            width: 34,
            height: 34,
            borderRadius: 17,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: playing ? td.priBg : hovered ? td.controlBg : td.wash2,
          },
          web({
            cursor: "pointer",
            boxShadow: playing ? td.liftSm : undefined,
            transition: "background .25s, transform .3s cubic-bezier(.16,1,.3,1)",
            transform: pressed ? "scale(.94)" : undefined,
          }) as ViewStyle,
        ]}
      >
        <Ph name={playing ? "pause" : "play"} weight="fill" size={13} color={playing ? "#FFFFFF" : td.accent} />
      </Pressable>
      {/* STOP — only while something is in flight (TODOAP-REQ-31). */}
      {runningCount > 0 ? (
        <Pressable
          testID="todo-autoplay-stop"
          accessibilityRole="button"
          accessibilityLabel={t("todo.autoplay.global.stop", { count: runningCount })}
          onPress={onStop}
          style={({ hovered, pressed }: any) => [
            {
              width: 34,
              height: 34,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: hovered ? td.controlBg : td.wash2,
            },
            web({
              cursor: "pointer",
              transition: "background .25s, transform .3s cubic-bezier(.16,1,.3,1)",
              transform: pressed ? "scale(.94)" : undefined,
            }) as ViewStyle,
          ]}
        >
          <Ph name="stop" weight="fill" size={12} color={td.rTx} />
        </Pressable>
      ) : null}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Tx testID="todo-autoplay-global-state" s={12.5} lh={16} c={playing ? td.text : td.text2}>
          {playing
            ? t("todo.autoplay.global.playing", { count: enabledCount })
            : t("todo.autoplay.global.paused")}
        </Tx>
        <Tx s={10.5} lh={14} c={td.txs} lines={2}>
          {t("todo.autoplay.global.hint")}
        </Tx>
      </View>
    </View>
  )
}

function RunnerCard({
  runner: r,
  globalPlaying,
  groups,
  menuOpen,
  onMenu,
  onSetScope,
  onSetSlots,
  onSetPlay,
  onRemove,
}: {
  runner: Runner
  /** The workspace's global play/pause (TODOAP-REQ-30) — the status line reads both levels. */
  globalPlaying: boolean
  groups: ScopeGroup[]
  menuOpen: boolean
  onMenu: (open: boolean) => void
  onSetScope: (agentId: string, scopeNodeId: string | null, pickUnassigned: boolean) => void
  onSetSlots: (agentId: string, slots: number) => void
  onSetPlay: (agentId: string, enabled: boolean) => void
  onRemove: (agentId: string) => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  // Two levels (TODOAP-REQ-30): disabled → Paused; enabled while the global is
  // paused → Paused · global; enabled and playing → Working / Waiting.
  const status = !r.playEnabled ? "paused" : !globalPlaying ? "pausedGlobal" : r.activeSlots > 0 ? "working" : "waiting"
  const person: Person = { kind: "agent", id: r.agentId, name: r.name, avatarUrl: r.avatarUrl }
  const canPlay = r.slots > 0
  return (
    <View
      testID={`todo-autoplay-runner-${r.agentId}`}
      style={[
        // The open scope menu overlaps the cards below.
        { flexDirection: "row", gap: 10, borderRadius: 16, backgroundColor: td.card, paddingTop: 12, paddingBottom: 10, paddingLeft: 12, paddingRight: 8, zIndex: menuOpen ? 20 : 0 },
        web({ boxShadow: td.cardShadow }) as ViewStyle,
      ]}
    >
      <View style={{ paddingTop: 1 }}>
        <PersonAvatar person={person} size={28} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        {/* Name · status */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 18, paddingRight: 4 }}>
          <Tx s={13} lh={18} c={td.text} lines={1} style={{ flexShrink: 1 }}>
            {r.name}
          </Tx>
          <View style={{ flex: 1 }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {status === "working" ? (
              <Dot state="working" size={7} running />
            ) : (
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: status === "waiting" ? td.accent : status === "pausedGlobal" ? td.accent : td.text3,
                }}
              />
            )}
            <Tx
              testID={`todo-autoplay-status-${r.agentId}`}
              s={11.5}
              lh={14}
              c={status === "paused" || status === "pausedGlobal" ? td.txs : td.text2}
            >
              {t(`todo.autoplay.${status}`)}
            </Tx>
          </View>
        </View>
        <ScopeLine runner={r} groups={groups} open={menuOpen} onOpen={onMenu} onSetScope={onSetScope} />
        {/* In progress · slots · play · remove */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Tx f="mono" s={10} lh={14} c={td.txs} lines={1} style={{ flex: 1, minWidth: 0 }}>
            {t("todo.autoplay.inProgress", { active: r.activeSlots, slots: r.slots })}
          </Tx>
          <View style={{ flexDirection: "row", alignItems: "center", height: 28, borderRadius: 100, backgroundColor: td.wash2, paddingHorizontal: 2 }}>
            <Step icon="minus" label={t("todo.autoplay.fewer", { name: r.name })} disabled={r.slots === 0} onPress={() => onSetSlots(r.agentId, r.slots - 1)} />
            <Tx f="mono" s={11} lh={14} c={td.text} style={{ minWidth: 16, textAlign: "center" }}>
              {String(r.slots)}
            </Tx>
            <Step icon="plus" label={t("todo.autoplay.more", { name: r.name })} onPress={() => onSetSlots(r.agentId, r.slots + 1)} />
          </View>
          <Pressable
            testID={`todo-autoplay-play-${r.agentId}`}
            accessibilityRole="button"
            accessibilityLabel={r.playEnabled ? t("todo.autoplay.disable", { name: r.name }) : t("todo.autoplay.enable", { name: r.name })}
            accessibilityState={{ disabled: !canPlay, checked: r.playEnabled }}
            disabled={!canPlay}
            onPress={() => onSetPlay(r.agentId, !r.playEnabled)}
            style={({ hovered, pressed }: any) => [
              {
                width: 30,
                height: 30,
                borderRadius: 15,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: r.playEnabled ? td.priBg : hovered && canPlay ? td.controlBg : td.wash2,
                opacity: canPlay ? 1 : 0.4,
              },
              web({
                cursor: canPlay ? "pointer" : "default",
                boxShadow: r.playEnabled ? td.liftSm : undefined,
                transition: "background .25s, transform .3s cubic-bezier(.16,1,.3,1)",
                transform: pressed && canPlay ? "scale(.94)" : undefined,
              }) as ViewStyle,
            ]}
          >
            <Ph name={r.playEnabled ? "pause" : "play"} weight="fill" size={12} color={r.playEnabled ? "#FFFFFF" : td.accent} />
          </Pressable>
          <IconBtn icon="x" size={26} iconSize={12} label={t("todo.autoplay.remove", { name: r.name })} onPress={() => onRemove(r.agentId)} />
        </View>
      </View>
    </View>
  )
}

function Step({ icon, label, onPress, disabled }: { icon: string; label: string; onPress: () => void; disabled?: boolean }) {
  const td = useTd()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered }: any) => [
        { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: hovered && !disabled ? td.card : "transparent", opacity: disabled ? 0.4 : 1 },
        web({ cursor: disabled ? "default" : "pointer", transition: "background .2s" }) as ViewStyle,
      ]}
    >
      <Ph name={icon} size={11} color={td.text} />
    </Pressable>
  )
}

/**
 * @spec TODOAP-REQ-22 The runner's one scope control: *Also picks up:* and a
 * menu chip whose short label is the current choice (Nothing / Today · any
 * branch / Today · the scope path / Branch deleted, the last only with pickup
 * on). Nothing on a missing scope sends `null`, never the deleted group. The menu: Nothing; PLANNED FOR TODAY → any
 * branch; PLANNED FOR TODAY, ONLY IN → the tree's groups. Each item writes
 * `set-agent-scope` with its pair.
 */
function ScopeLine({
  runner: r,
  groups,
  open,
  onOpen,
  onSetScope,
}: {
  runner: Runner
  groups: ScopeGroup[]
  open: boolean
  onOpen: (open: boolean) => void
  onSetScope: (agentId: string, scopeNodeId: string | null, pickUnassigned: boolean) => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  const boxRef = useRef<View>(null)
  useDismiss(open, () => onOpen(false), boxRef)

  // scopeMissing first: the stored id is kept while the path is null.
  const local = r.scopeNodeId ? groups.find((g) => g.nodeId === r.scopeNodeId) : undefined
  const path = r.scopePath ?? (local ? [...local.ancestors, local.title].join(" › ") : "")
  // Nothing wins: with pickup off the chip never reports a deleted branch.
  const missing = r.pickUnassigned && r.scopeMissing
  const label = !r.pickUnassigned
    ? t("todo.autoplay.scope.nothing")
    : missing
      ? t("todo.autoplay.scope.missing")
      : r.scopeNodeId === null
        ? t("todo.autoplay.scope.any")
        : t("todo.autoplay.scope.in", { path, interpolation: { escapeValue: false } })
  const choose = (scopeNodeId: string | null, pickUnassigned: boolean) => {
    onOpen(false)
    onSetScope(r.agentId, scopeNodeId, pickUnassigned)
  }

  return (
    <View ref={boxRef} testID={`todo-autoplay-scope-${r.agentId}`} style={{ position: "relative", flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0, zIndex: open ? 10 : 0 }}>
      <Tx f="mono" s={9.5} lh={14} c={td.txs} lines={1} style={{ flexShrink: 0 }}>
        {t("todo.autoplay.scope.label")}
      </Tx>
      <Btn sm tone="out" label={t("todo.autoplay.scope.choose", { name: r.name })} onPress={() => onOpen(!open)} style={{ flexShrink: 1, minWidth: 0, maxWidth: "100%", paddingLeft: 8, paddingRight: 4, gap: 3 }}>
        <Tx testID={`todo-autoplay-scope-label-${r.agentId}`} s={11} lh={14} c={missing ? td.rTx : td.text} lines={1} style={{ flexShrink: 1, minWidth: 0 }}>
          {label}
        </Tx>
        <Ph name="caret-down" size={9} color={td.text3} />
      </Btn>
      {open ? (
        // Anchored under the card's avatar column so the menu has the card's width.
        <MenuBox minWidth={0} label={t("todo.autoplay.scope.label")} style={{ left: -38, width: 276, maxHeight: 300 }}>
          <ScrollView style={{ maxHeight: 260 }} {...tdx("scroll")}>
            <ScopeItem label={t("todo.autoplay.scope.nothingItem", { name: r.name })} ancestors={[]} checked={!r.pickUnassigned} onPress={() => choose(r.scopeMissing ? null : r.scopeNodeId, false)} />
            <MenuHead>{t("todo.autoplay.scope.today")}</MenuHead>
            <ScopeItem label={t("todo.autoplay.scope.anyItem")} ancestors={[]} checked={r.pickUnassigned && r.scopeNodeId === null} onPress={() => choose(null, true)} />
            {groups.length ? <MenuHead>{t("todo.autoplay.scope.onlyIn")}</MenuHead> : null}
            {groups.map((g) => (
              <ScopeItem
                key={g.nodeId}
                label={g.title}
                ancestors={g.ancestors}
                checked={r.pickUnassigned && !r.scopeMissing && r.scopeNodeId === g.nodeId}
                onPress={() => choose(g.nodeId, true)}
              />
            ))}
          </ScrollView>
        </MenuBox>
      ) : null}
    </View>
  )
}

function ScopeItem({ label, ancestors, checked, onPress }: { label: string; ancestors: string[]; checked: boolean; onPress: () => void }) {
  const td = useTd()
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={{ checked }}
      {...({ "aria-checked": checked } as Record<string, unknown>)}
      accessibilityLabel={[...ancestors, label].join(" › ")}
      onPress={onPress}
      style={({ hovered }: any) => [
        { flexDirection: "row", alignItems: "center", minHeight: 32, paddingHorizontal: 9, borderRadius: 9, backgroundColor: hovered ? td.wash2 : checked ? td.navActive : "transparent" },
        web({ cursor: "pointer", outlineStyle: "none" }) as ViewStyle,
      ]}
    >
      <Tx s={12.5} lh={16} c={td.text} lines={1} style={{ flexShrink: 1 }}>
        {ancestors.length ? <Tx s={12.5} lh={16} c={td.txs}>{`${ancestors.join(" › ")} › `}</Tx> : null}
        {label}
      </Tx>
    </Pressable>
  )
}
