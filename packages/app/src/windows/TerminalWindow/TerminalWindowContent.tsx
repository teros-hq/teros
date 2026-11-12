/**
 * TerminalWindowContent — "el asiento, en lateral": the workspace's terminals
 * as a crew rail (one face per terminal, its seat showing who drives) beside
 * ONE terminal with a slim header. No tabs, no session list, no split.
 *
 * Sessions live in the workspace's terminal host (tmux, server side): this
 * window only shows them; ending one is an explicit action. The window
 * remembers the terminal it shows (`active`) and the rail's side
 * (`railSide`), so reopening it — after a reload, on another device — shows
 * the same.
 *
 * Following the agent is implicit: when a Teros agent creates or drives a
 * terminal (mca.teros.terminal tools), the window shows it without taking the
 * keyboard. Picking a face by hand pauses that until the agent's next action
 * (and never while the person is typing here).
 *
 * Who drives (driver / watchers / conflict) comes from the backend's crew
 * contract; older backends get a lastInput-based fallback (crew/crewModel).
 * Faces dragged out of the rail float above everything (tg-crew-float's
 * layer, ./floating); a floating terminal is not shown in this pane.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Keyboard, type LayoutChangeEvent, Platform, Pressable, Text, View } from "react-native"
import { useColors, useMcaTheme } from "../../components/mca/primitives/useColors"
import { useToast } from "../../components/Toast"
import { AppSpinner } from "../../components/ui"
import { Btn, EmptyState, Ph } from "../../components/ui/ds"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useAuthStore } from "../../store/authStore"
import { useNavbarStore } from "../../store/navbarStore"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { AgentAuthCard, type AgentAuthStatus, type CodingAgent } from "./AgentAuthCard"
import { CloseConfirm } from "./crew/CloseConfirm"
import { CrewMenu, type CrewMenuEntry } from "./crew/CrewMenu"
import { CrewRail, type RailSide } from "./crew/CrewRail"
import {
  type CloseReason,
  cancelClose,
  closeReason,
  scheduleClose,
  UNDO_MS,
} from "./crew/closeTerminal"
import { type CrewPerson, describeSeat, firstName } from "./crew/crewModel"
import { css } from "./crew/crewMotion"
import { Face } from "./crew/Face"
import { TerminalHeader } from "./crew/TerminalHeader"
import { NARROW_PX, RAIL, SANS, useK } from "./crew/tokens"
import type { TerminalWindowProps } from "./definition"
import { ExtraKeysBar } from "./ExtraKeysBar"
import { terminalFloat, useTerminalFloatStore } from "./floating"
import {
  type PaneLiveState,
  TerminalView,
  type TerminalViewHandle,
  type WindowShortcut,
} from "./TerminalView"
import { followUpdate, latestAgentSession } from "./terminalLayout"
import {
  newTerminalId,
  onFocusSessionRequest,
  sessionLabel,
  type TerminalSession,
  useTerminalSessions,
} from "./terminalSessions"
import { useBashApp } from "./useBashApp"

interface Props extends TerminalWindowProps {
  windowId: string
}

/**
 * A cold create (bash warmup + terminal host + tmux + coding-agent hooks) can
 * take far longer than the 10 s request default; timing out early made people
 * click again and start a second session. A timed-out create is retried once
 * with the same id (idempotent server side).
 */
const CREATE_TIMEOUT_MS = 120_000
/** Following the agent never pulls the pane away from someone typing in it. */
const TYPING_GRACE_MS = 15_000
const SIDE_SAVED_KEY = "teros.terminal.crewRail.sideSaved"

const CODING_AGENTS = ["claude", "codex", "opencode"]

function readOptionIsMeta(): boolean {
  try {
    return Platform.OS === "web" && localStorage.getItem("teros.terminal.optionIsMeta") === "1"
  } catch {
    return false
  }
}

function isTouch(): boolean {
  if (Platform.OS !== "web") return true
  try {
    return window.matchMedia?.("(pointer: coarse)").matches === true
  } catch {
    return false
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && /timeout/i.test(err.message)
}

/** The agent at the wheel of a session (contract driver, or its last keystroke). */
function agentOf(s: TerminalSession): CrewPerson | null {
  const d = s.driver
  if (d?.kind === "agent" && d.id)
    return { id: d.id, kind: "agent", name: d.name ?? "", avatarUrl: d.avatarUrl }
  const li = s.lastInput
  if (li?.kind === "agent") return { id: li.id, kind: "agent", name: li.name ?? "" }
  return null
}

export function TerminalWindowContent({
  windowId,
  initialCwd,
  appId: propAppId,
  workspaceId: propWorkspaceId,
  sessionId: legacySessionId,
  active: propActive,
  railSide: propRailSide,
}: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const K = useK()
  const theme = useMcaTheme()
  const toast = useToast()
  const client = getTerosClient()

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const me = useAuthStore((s) => s.user?.userId)
  const workspaceId = propWorkspaceId ?? activeWorkspaceId ?? ""
  const role = useNavbarStore((s) => s.workspaces.find((w) => w.workspaceId === workspaceId)?.role)
  // Terminals need write access (a read member gets nothing server-side either).
  const readOnlyRole = role === "read"

  const {
    appId: resolvedAppId,
    mcaId: resolvedMcaId,
    loading: appLoading,
    reload: reloadApps,
  } = useBashApp(propAppId ? undefined : workspaceId)
  const appId = propAppId ?? resolvedAppId
  const { sessions, loaded } = useTerminalSessions(readOnlyRole ? null : workspaceId)
  const byId = useMemo(() => new Map(sessions.map((s) => [s.terminalId, s])), [sessions])

  const updateWindowProps = useTilingStore((s) => s.updateWindowProps)
  const focusWindow = useTilingStore((s) => s.focusWindow)
  const closeWindow = useTilingStore((s) => s.closeWindow)
  const floatingMap = useTerminalFloatStore((s) => s.floating)

  // One Terminal window per workspace (older layouts may hold several): the first one keeps it.
  useEffect(() => {
    if (!workspaceId) return
    const all = Object.values(useTilingStore.getState().windows).filter(
      (w) => w.type === "terminal" && (w.props.workspaceId ?? workspaceId) === workspaceId,
    )
    if (all.length < 2) return
    const keeper = all.map((w) => w.id).sort()[0]
    if (keeper === windowId) return
    closeWindow(windowId)
    focusWindow(keeper)
  }, [workspaceId, windowId, closeWindow, focusWindow])

  const side: RailSide = propRailSide === "left" ? "left" : "right"
  const selectedId = propActive ?? legacySessionId ?? null
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId

  const [width, setWidth] = useState(0)
  const narrow = width > 0 && width < NARROW_PX
  const railW = narrow ? RAIL.narrow.w : RAIL.wide.w

  const [menuOpen, setMenuOpen] = useState(false)
  /** Closed by hand, still undoable: hidden from the rail until the destroy runs. */
  const [closing, setClosing] = useState<string[]>([])
  const [confirmClose, setConfirmClose] = useState<{ id: string; reason: CloseReason } | null>(null)
  const [live, setLive] = useState<Record<string, PaneLiveState>>({})
  const [mods, setMods] = useState({ ctrl: false, alt: false })
  const [installing, setInstalling] = useState(false)
  const [pending, setPending] = useState<string[]>([])
  const creatingRef = useRef(false)
  const [optionIsMeta, setOptionIsMeta] = useState(readOptionIsMeta)
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  /** The last switch was the window following the agent: don't take the keyboard. */
  const [quietSwitch, setQuietSwitch] = useState(false)
  const [railDrag, setRailDrag] = useState<boolean | null>(null)
  const [now, setNow] = useState(() => Date.now())
  /** Coding-agent sign-in card (in place of the pane), and sessions whose login screen the user dismissed. */
  const [authCard, setAuthCard] = useState<{
    agent: CodingAgent
    reason: "first-session" | "login-screen" | "change"
    sessionId?: string
  } | null>(null)
  const dismissedAuth = useRef(new Set<string>())
  const pane = useRef<TerminalViewHandle>(null)
  /** Ids created here: in flight, then a grace period until the session list catches up. */
  const freshIds = useRef(new Map<string, number>())
  const followSeen = useRef<Map<string, number> | null>(null)
  /** Client time I last typed in the pane. */
  const typedAt = useRef(0)
  /** The agent that last drove each session (Give back goes to it; co-pilot). */
  const lastAgent = useRef(new Map<string, CrewPerson>())
  const touch = useMemo(isTouch, [])

  // Elapsed times, the breathing ring and the lastInput fallback age with the clock.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  for (const s of sessions) {
    const a = agentOf(s)
    if (a)
      lastAgent.current.set(s.terminalId, {
        ...lastAgent.current.get(s.terminalId),
        ...a,
        name: a.name || lastAgent.current.get(s.terminalId)?.name || "",
      })
  }

  const select = useCallback(
    (terminalId: string | null) => {
      selectedRef.current = terminalId
      updateWindowProps(windowId, { active: terminalId ?? undefined, sessionId: undefined })
    },
    [updateWindowProps, windowId],
  )

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width)
    setWidth((prev) => (Math.abs(prev - w) >= 4 ? w : prev))
  }, [])

  // ── Keyboard (touch): keep the extra keys above the virtual keyboard ──────

  useEffect(() => {
    if (!touch) return
    if (Platform.OS === "web") {
      const vv = window.visualViewport
      if (!vv) return
      const onResize = () => setKeyboardHeight(Math.max(0, window.innerHeight - vv.height))
      vv.addEventListener("resize", onResize)
      return () => vv.removeEventListener("resize", onResize)
    }
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (e) => setKeyboardHeight(e.endCoordinates.height),
    )
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardHeight(0),
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [touch])

  // ── What the pane shows ─────────────────────────────────────────────────

  const isFloating = useCallback((id: string) => !!floatingMap[id], [floatingMap])
  // Terminals closed by hand leave the rail at once (the destroy waits for the undo window).
  const visible = useMemo(
    () => (closing.length ? sessions.filter((s) => !closing.includes(s.terminalId)) : sessions),
    [sessions, closing],
  )
  const docked = useMemo(
    () => visible.filter((s) => !isFloating(s.terminalId)),
    [visible, isFloating],
  )
  // The selected terminal, unless it floats (then the first docked one).
  const shownId = useMemo(() => {
    if (selectedId && pending.includes(selectedId)) return selectedId
    if (
      selectedId &&
      byId.has(selectedId) &&
      !isFloating(selectedId) &&
      !closing.includes(selectedId)
    )
      return selectedId
    if (selectedId && !loaded) return selectedId
    return docked[0]?.terminalId ?? null
  }, [selectedId, pending, byId, isFloating, closing, loaded, docked])

  /** The person picked a face: show it (or bring its floating window up). */
  const pick = useCallback(
    (terminalId: string) => {
      if (isFloating(terminalId)) {
        terminalFloat.focus(terminalId)
        return
      }
      setQuietSwitch(false)
      select(terminalId)
    },
    [isFloating, select],
  )

  /** The window follows the agent into a terminal (keeps the keyboard where it is). */
  const showFollowed = useCallback(
    (terminalId: string) => {
      if (terminalId === selectedRef.current || isFloating(terminalId)) return
      setQuietSwitch(true)
      select(terminalId)
    },
    [isFloating, select],
  )

  // A terminal docked from its floating window comes back selected.
  const prevFloating = useRef<string[]>(Object.keys(floatingMap))
  useEffect(() => {
    const now = Object.keys(floatingMap)
    const back = prevFloating.current.filter((id) => !now.includes(id) && byId.has(id))
    prevFloating.current = now
    if (back.length > 0) {
      setQuietSwitch(false)
      select(back[back.length - 1])
    }
  }, [floatingMap, byId, select])

  // ── Create / end ────────────────────────────────────────────────────────

  const createSession = useCallback(
    async (preset: "shell" | "claude") => {
      if (!appId || !client || creatingRef.current) return
      creatingRef.current = true
      const terminalId = newTerminalId()
      const shells = sessions.filter((s) => s.kind === "shell").length
      // The face shows up at once ("Opening…"): nothing invites a second click.
      setPending((p) => [...p, terminalId])
      setQuietSwitch(false)
      select(terminalId)
      const payload = {
        terminalId,
        appId,
        mcaId: resolvedMcaId,
        cols: 120,
        rows: 36,
        preset,
        title: preset === "claude" ? "Claude Code" : `Shell ${shells + 1}`,
        cwd: initialCwd,
        subscribe: false,
      }
      const create = () =>
        client.transport.request("terminal.create", payload, { timeout: CREATE_TIMEOUT_MS })
      try {
        try {
          await create()
        } catch (err) {
          if (!isTimeout(err)) throw err
          await create() // same id: joins the first create if it is still running
        }
        freshIds.current.set(terminalId, Date.now())
      } catch (err) {
        if (selectedRef.current === terminalId) select(null)
        toast.error(
          t("terminal.createFailed", { defaultValue: "Could not open a terminal" }),
          err instanceof Error ? err.message : String(err),
        )
      } finally {
        creatingRef.current = false
        setPending((p) => p.filter((id) => id !== terminalId))
      }
    },
    [appId, client, sessions, resolvedMcaId, initialCwd, select, toast, t],
  )

  const killSession = useCallback(
    (terminalId: string) => {
      client
        ?.send("terminal", "destroy", { terminalId })
        .catch((err: unknown) =>
          toast.error(
            t("terminal.killFailed", { defaultValue: "Could not end the session" }),
            String(err),
          ),
        )
      terminalFloat.dock(terminalId)
      if (selectedRef.current === terminalId) {
        const next = docked.find((s) => s.terminalId !== terminalId)
        select(next?.terminalId ?? null)
      }
    },
    [client, docked, select, toast, t],
  )

  /** Close now; `undoable`: the destroy waits UNDO_MS behind a "Deshacer" toast. */
  const closeNow = useCallback(
    (terminalId: string, undoable: boolean) => {
      const s = byId.get(terminalId)
      if (!undoable) {
        killSession(terminalId)
        return
      }
      setClosing((c) => (c.includes(terminalId) ? c : [...c, terminalId]))
      const wasFloating = isFloating(terminalId)
      terminalFloat.dock(terminalId)
      if (selectedRef.current === terminalId) {
        const next = docked.find((x) => x.terminalId !== terminalId)
        select(next?.terminalId ?? null)
      }
      scheduleClose(terminalId, () => {
        client?.send("terminal", "destroy", { terminalId }).catch((err: unknown) => {
          setClosing((c) => c.filter((x) => x !== terminalId))
          toast.error(
            t("terminal.killFailed", { defaultValue: "Could not end the session" }),
            String(err),
          )
        })
      })
      toast.show(
        t("terminal.crew.closed", {
          defaultValue: "{{name}} closed",
          name: s ? sessionLabel(s) : t("terminal.crew.terminal", { defaultValue: "Terminal" }),
        }),
        {
          type: "info",
          duration: UNDO_MS,
          action: {
            label: t("terminal.crew.undo", { defaultValue: "Undo" }),
            onPress: () => {
              if (!cancelClose(terminalId)) return
              setClosing((c) => c.filter((x) => x !== terminalId))
              if (wasFloating) terminalFloat.popOut(terminalId)
              else {
                setQuietSwitch(false)
                select(terminalId)
              }
            },
          },
        },
      )
    },
    [byId, killSession, isFloating, docked, select, client, toast, t],
  )

  /** Close by hand: at once (with undo), or ask first when it would cut something off. */
  const requestClose = useCallback(
    (terminalId: string) => {
      const s = byId.get(terminalId)
      if (!s) return
      const reason = closeReason(s, me)
      if (reason) setConfirmClose({ id: terminalId, reason })
      else closeNow(terminalId, true)
    },
    [byId, me, closeNow],
  )

  /** "Claude Code": the sign-in card first when the person has no credentials yet. */
  const startClaude = useCallback(async () => {
    if (!client || !workspaceId) return
    try {
      const status = (await client.send("terminal", "agentAuthStatus", {
        agent: "claude",
        workspaceId,
      })) as AgentAuthStatus
      if (!status.mode) {
        setAuthCard({ agent: "claude", reason: "first-session" })
        return
      }
    } catch {
      // Status unavailable: start anyway, Claude Code shows its own sign-in.
    }
    void createSession("claude")
  }, [client, workspaceId, createSession])

  const onAuthDone = useCallback(
    (status: AgentAuthStatus) => {
      const card = authCard
      setAuthCard(null)
      if (!card) return
      // My other Claude Code sessions still run with the sign-in they started with.
      const stale = sessions.filter(
        (s) =>
          s.kind === card.agent &&
          s.createdBy === me &&
          s.terminalId !== card.sessionId &&
          (s.auth ?? "") !== (status.label ?? ""),
      )
      if (card.reason === "first-session") void createSession("claude")
      else if (card.reason === "login-screen") {
        // That session was only a login screen: replace it with one that has the credentials.
        void createSession("claude")
        if (card.sessionId) killSession(card.sessionId)
      } else if (stale.length === 0) {
        toast.success(
          t("terminal.auth.saved", {
            defaultValue: "New {{name}} sessions will use: {{label}}",
            name: "Claude Code",
            label: status.label ?? "",
          }),
        )
      }
      if (stale.length > 0 && status.label) {
        toast.show(
          t("terminal.auth.restartOffer", {
            defaultValue: "{{count}} open Claude Code sessions still use your previous sign-in",
            count: stale.length,
          }),
          {
            type: "info",
            duration: 20_000,
            action: {
              label: t("terminal.auth.restartAction", {
                defaultValue: "Restart as {{label}}",
                label: status.label,
              }),
              onPress: () => {
                void (async () => {
                  for (const s of stale) {
                    await createSession("claude")
                    killSession(s.terminalId)
                  }
                })()
              },
            },
          },
        )
      }
    },
    [authCard, sessions, me, createSession, killSession, toast, t],
  )

  // ── The wheel ───────────────────────────────────────────────────────────

  const wheel = useCallback(
    (action: "takeWheel" | "giveBack" | "yield", payload: Record<string, unknown>) => {
      if (!client) return
      client.send("terminal", action, payload).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(
          action === "giveBack"
            ? t("terminal.crew.giveBackFailed", { defaultValue: "Could not give the wheel back" })
            : t("terminal.crew.takeFailed", { defaultValue: "Could not take the wheel" }),
          /unknown|not found|no handler/i.test(msg)
            ? t("terminal.crew.notYet", { defaultValue: "This server doesn't know the wheel yet." })
            : msg,
        )
      })
    },
    [client, toast, t],
  )
  const takeWheel = useCallback(
    (terminalId: string) => {
      wheel("takeWheel", { terminalId })
      if (terminalId === shownId) pane.current?.focus()
    },
    [wheel, shownId],
  )
  const giveBack = useCallback(
    (terminalId: string, note: string | null) =>
      wheel("giveBack", { terminalId, note: note ?? undefined }),
    [wheel],
  )
  const yieldTo = useCallback(
    (terminalId: string, to: string) => wheel("yield", { terminalId, to }),
    [wheel],
  )

  // ── The rail's side ─────────────────────────────────────────────────────

  const railBox = useRef<any>(null)
  const railFrom = useRef<number | null>(null)
  const setSide = useCallback(
    (next: RailSide) => {
      if (next === side) return
      const el = railBox.current as HTMLElement | null
      railFrom.current = el?.getBoundingClientRect ? el.getBoundingClientRect().left : null
      updateWindowProps(windowId, { railSide: next })
      let saved = false
      try {
        saved = localStorage.getItem(SIDE_SAVED_KEY) === "1"
        localStorage.setItem(SIDE_SAVED_KEY, "1")
      } catch {
        /* not remembered: say it again next time */
      }
      if (!saved)
        toast.success(
          next === "left"
            ? t("terminal.crew.sideSavedLeft", { defaultValue: "Saved: the crew goes on the left" })
            : t("terminal.crew.sideSavedRight", {
                defaultValue: "Saved: the crew goes on the right",
              }),
        )
    },
    [side, updateWindowProps, windowId, toast, t],
  )
  // The rail crosses in 220 ms (FLIP); the terminal is not re-rendered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the new side is laid out
  useLayoutEffect(() => {
    const from = railFrom.current
    railFrom.current = null
    const el = railBox.current as HTMLElement | null
    if (from === null || !el?.animate) return
    const dx = from - el.getBoundingClientRect().left
    if (Math.abs(dx) < 2) return
    try {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    } catch {
      /* animate */
    }
    el.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], {
      duration: 220,
      easing: "cubic-bezier(.2,.8,.2,1)",
    })
  }, [side])

  // ── Following the agent (implicit) ──────────────────────────────────────

  useEffect(() => {
    if (!loaded) return
    if (followSeen.current === null) {
      // First list: what happened before the window opened is not news…
      followSeen.current = followUpdate(new Map(), sessions).seen
      // …but a window with nothing chosen shows where the agent works.
      if (!selectedRef.current || !byId.has(selectedRef.current)) {
        const id = latestAgentSession(sessions)
        if (id) showFollowed(id)
      }
      return
    }
    const { seen, target } = followUpdate(followSeen.current, sessions)
    followSeen.current = seen
    if (!target) return
    // The agent acted (a manual pick held the window only until now), but
    // nobody is pulled away from a terminal they are typing in.
    const shown = selectedRef.current ? byId.get(selectedRef.current) : undefined
    const mine = shown?.lastInput?.kind === "human" && shown.lastInput.id === me
    const lastTyped = Math.max(typedAt.current, mine && shown?.lastInput ? shown.lastInput.at : 0)
    if (Date.now() - lastTyped < TYPING_GRACE_MS) return
    showFollowed(target)
  }, [loaded, sessions, byId, me, showFollowed])

  // Ids that ended elsewhere: the selection moves on (fresh ids get a grace period).
  useEffect(() => {
    if (!loaded || !selectedId || pending.includes(selectedId) || byId.has(selectedId)) return
    const at = freshIds.current.get(selectedId)
    if (at && Date.now() - at < 15_000) return
    select(docked[0]?.terminalId ?? null)
  }, [loaded, selectedId, pending, byId, docked, select])

  // "Show this session" (a toast's Open action): this window takes it if the session is ours.
  useEffect(
    () =>
      onFocusSessionRequest((terminalId) => {
        if (!byId.has(terminalId)) return false
        if (isFloating(terminalId)) terminalFloat.focus(terminalId)
        else {
          setQuietSwitch(false)
          select(terminalId)
        }
        focusWindow(windowId)
        return true
      }),
    [byId, isFloating, select, focusWindow, windowId],
  )

  // A Claude Code session I opened is on its login screen: show the sign-in card (once per session).
  const shownSession = shownId ? byId.get(shownId) : undefined
  useEffect(() => {
    const s = shownSession
    if (!s || s.needsAuth !== "claude" || authCard) return
    if (s.createdBy !== me || dismissedAuth.current.has(s.terminalId)) return
    setAuthCard({ agent: "claude", reason: "login-screen", sessionId: s.terminalId })
  }, [shownSession, authCard, me])

  // ── Live pane state ─────────────────────────────────────────────────────

  const onLive = useCallback(
    (terminalId: string, patch: Partial<PaneLiveState>) => {
      setLive((prev) => {
        const base: PaneLiveState = prev[terminalId] ?? {
          status: "connecting",
          typing: null,
          watchers: [],
        }
        return { ...prev, [terminalId]: { ...base, ...patch } }
      })
      if (patch.typing?.kind === "human" && patch.typing.id === me) typedAt.current = Date.now()
    },
    [me],
  )

  const cycle = useCallback(
    (dir: 1 | -1) => {
      if (docked.length < 2 || !shownId) return
      const i = docked.findIndex((s) => s.terminalId === shownId)
      const next = docked[(i + dir + docked.length) % docked.length]
      if (next) pick(next.terminalId)
    },
    [docked, shownId, pick],
  )

  const onShortcut = useCallback(
    (action: WindowShortcut) => {
      switch (action) {
        case "prev-session":
          return cycle(-1)
        case "next-session":
          return cycle(1)
        case "take-wheel":
          return shownId ? takeWheel(shownId) : undefined
        case "float":
          return shownId ? terminalFloat.popOut(shownId) : undefined
        case "rail-left":
          return setSide("left")
        case "rail-right":
          return setSide("right")
      }
    },
    [cycle, shownId, takeWheel, setSide],
  )

  const installBash = useCallback(async () => {
    if (!client || !workspaceId) return
    setInstalling(true)
    try {
      await client.installWorkspaceApp(workspaceId, "mca.teros.bash")
      toast.success(
        t("terminal.bashInstalled", { defaultValue: "Bash installed — opening a terminal" }),
      )
      reloadApps()
    } catch (err) {
      toast.error(
        t("terminal.installFailed", { defaultValue: "Could not install Bash" }),
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      setInstalling(false)
    }
  }, [client, workspaceId, toast, t, reloadApps])

  const toggleOptionMeta = useCallback(() => {
    setOptionIsMeta((v) => {
      try {
        localStorage.setItem("teros.terminal.optionIsMeta", v ? "0" : "1")
      } catch {
        /* not remembered */
      }
      return !v
    })
  }, [])

  // ── Render ──────────────────────────────────────────────────────────────

  if (readOnlyRole) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bgSheet, justifyContent: "center" }}>
        <EmptyState
          icon="lock"
          title={t("terminal.readRoleTitle", { defaultValue: "Terminals need write access" })}
          text={t("terminal.readRoleText", {
            defaultValue:
              "A terminal is a shell in this workspace's machine, and its screen can show secrets. Ask an admin for write access.",
          })}
        />
      </View>
    )
  }

  if (!appLoading && !appId) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bgSheet, justifyContent: "center" }}>
        <EmptyState
          icon="terminal-window"
          title={t("terminal.noBashApp")}
          text={t("terminal.installBashHint")}
          action={
            <Btn
              variant="primary"
              icon="download-simple"
              loading={installing}
              onPress={installBash}
              testID="terminal-install-bash"
            >
              {t("terminal.installBash", { defaultValue: "Install Bash and open a terminal" })}
            </Btn>
          }
        />
      </View>
    )
  }

  const paneLabels = {
    starting: t("terminal.pane.starting", { defaultValue: "Starting…" }),
    reconnecting: t("terminal.reconnecting", { defaultValue: "Reconnecting…" }),
    retry: t("terminal.pane.retry", { defaultValue: "Retry" }),
    ended: t("terminal.ended", { defaultValue: "Session ended" }),
    restart: t("terminal.pane.restart", { defaultValue: "Restart" }),
    close: t("common.close", { defaultValue: "Close" }),
    denied: t("terminal.pane.denied", { defaultValue: "You don't have access to this session" }),
    jump: t("terminal.pane.jump", { defaultValue: "Jump to the bottom" }),
    readOnly: t("terminal.pane.readOnly", {
      defaultValue: "{{name}} has the wheel — view only",
    }),
    takeWheel: t("terminal.crew.takeWheel", { defaultValue: "Take the wheel" }),
  }

  const shownView = shownSession ? describeSeat(shownSession, me, now) : null
  // While a person drives, the agent that waits is in the watchers (crew contract): it is the co-pilot.
  const waitingAgent = shownView?.watchers.find((w) => w.kind === "agent")
  const copilot: CrewPerson | null = waitingAgent
    ? {
        id: waitingAgent.id,
        kind: "agent",
        name: waitingAgent.name,
        avatarUrl: waitingAgent.avatarUrl,
      }
    : shownId
      ? (lastAgent.current.get(shownId) ?? null)
      : null
  const shownLive = shownId ? live[shownId] : undefined
  const isCodingAgent = !!shownSession && CODING_AGENTS.includes(shownSession.kind)
  const agentName = shownSession?.kind === "claude" ? "Claude Code" : (shownSession?.kind ?? "")
  const allFloating = loaded && visible.length > 0 && docked.length === 0 && pending.length === 0
  const empty = loaded && visible.length === 0 && pending.length === 0

  const connLabel = (status: PaneLiveState["status"] | undefined): string =>
    status === "live"
      ? t("terminal.live", { defaultValue: "Live" })
      : status === "ended"
        ? t("terminal.ended", { defaultValue: "Session ended" })
        : status === "denied"
          ? t("terminal.denied", { defaultValue: "No access" })
          : status === "offline"
            ? t("terminal.reconnecting", { defaultValue: "Reconnecting…" })
            : t("terminal.connecting", { defaultValue: "Connecting…" })

  const menuEntries: CrewMenuEntry[] = [
    ...(shownId
      ? ([
          {
            key: "float",
            icon: "picture-in-picture",
            label: t("terminal.crew.float", { defaultValue: "Float" }),
            kbd: "⌘⇧F",
            onPress: () => terminalFloat.popOut(shownId),
          },
          ...(shownView && !shownView.mine
            ? [
                {
                  key: "take",
                  icon: "steering-wheel",
                  label: t("terminal.crew.takeWheel", { defaultValue: "Take the wheel" }),
                  kbd: "⌘⇧K",
                  onPress: () => takeWheel(shownId),
                },
              ]
            : []),
          "separator",
        ] as CrewMenuEntry[])
      : []),
    { header: t("terminal.crew.crew", { defaultValue: "Crew" }) },
    {
      key: "side-left",
      icon: "sidebar-simple",
      label: t("terminal.crew.onLeft", { defaultValue: "On the left" }),
      kbd: "⌥⌘[",
      checked: side === "left",
      onPress: () => setSide("left"),
    },
    {
      key: "side-right",
      icon: "sidebar-simple",
      label: t("terminal.crew.onRight", { defaultValue: "On the right" }),
      kbd: "⌥⌘]",
      checked: side === "right",
      onPress: () => setSide("right"),
    },
    "separator",
    ...(Platform.OS === "web" && !touch
      ? [
          {
            key: "option-meta",
            icon: "option",
            label: t("terminal.optionMeta", { defaultValue: "Option key as Meta (Alt)" }),
            checked: optionIsMeta,
            onPress: toggleOptionMeta,
          },
        ]
      : []),
    ...(isCodingAgent && shownSession
      ? [
          {
            key: "sign-in",
            icon: "sign-in",
            label: t("terminal.bar.signIn", {
              defaultValue: "{{name}} sign-in: {{label}}",
              name: agentName,
              label:
                shownSession.auth || t("terminal.auth.none", { defaultValue: "not signed in" }),
            }),
            onPress: () =>
              setAuthCard({ agent: shownSession.kind as CodingAgent, reason: "change" }),
          },
        ]
      : []),
    ...(shownId && shownSession
      ? [
          {
            key: "close",
            icon: "x",
            label: t("terminal.crew.close", { defaultValue: "Close terminal" }),
            danger: true,
            onPress: () => requestClose(shownId),
          },
        ]
      : []),
  ]

  const menuFooter = shownSession
    ? [
        connLabel(shownLive?.status),
        typeof shownLive?.echoP50 === "number" ? `${shownLive.echoP50} ms` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined

  const rail = (
    <View ref={railBox} style={{ flexDirection: "column", zIndex: 4 }}>
      <CrewRail
        side={side}
        narrow={narrow}
        sessions={visible}
        pending={pending}
        selectedId={shownId}
        me={me}
        now={now}
        canCreate={!!appId && pending.length === 0}
        travel={Math.max(0, width - railW)}
        onPick={pick}
        onNew={(preset) => (preset === "claude" ? void startClaude() : void createSession("shell"))}
        onSwitchSide={() => setSide(side === "left" ? "right" : "left")}
        onPopOut={(id) => terminalFloat.popOut(id)}
        onTakeWheel={takeWheel}
        onClose={requestClose}
        onRailDrag={setRailDrag}
      />
    </View>
  )

  let body: React.ReactNode
  if (authCard && appId) {
    body = (
      <AgentAuthCard
        agent={authCard.agent}
        workspaceId={workspaceId}
        appId={appId}
        reason={authCard.reason}
        sessionAuth={authCard.sessionId ? (byId.get(authCard.sessionId)?.auth ?? "") : undefined}
        onDone={onAuthDone}
        onClose={() => {
          if (authCard.sessionId) dismissedAuth.current.add(authCard.sessionId)
          setAuthCard(null)
        }}
      />
    )
  } else if (appLoading || !loaded) {
    body = (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: K.canvas,
        }}
      >
        <AppSpinner size="md" variant="onFill" />
      </View>
    )
  } else if (empty) {
    body = (
      <CrewEmpty
        canCreate={!!appId}
        onShell={() => void createSession("shell")}
        onClaude={() => void startClaude()}
      />
    )
  } else if (allFloating) {
    body = <AllFloating sessions={visible} />
  } else if (shownId) {
    body = (
      <>
        {shownSession && shownView ? (
          <TerminalHeader
            session={shownSession}
            view={shownView}
            narrow={narrow}
            now={now}
            me={me}
            copilot={copilot}
            menuOpen={menuOpen}
            onTake={() => takeWheel(shownId)}
            onGiveBack={(note) => giveBack(shownId, note)}
            onYield={(to) => yieldTo(shownId, to)}
            onPopOut={() => terminalFloat.popOut(shownId)}
            onMenu={() => {
              setMenuOpen((v) => !v)
            }}
          />
        ) : (
          <OpeningHeader terminalId={shownId} />
        )}
        <View style={{ flex: 1 }}>
          <TerminalView
            ref={pane}
            terminalId={shownId}
            theme={theme}
            optionIsMeta={optionIsMeta}
            background={K.canvas}
            onLive={onLive}
            onFocus={() => setQuietSwitch(false)}
            onModifierReset={() => setMods({ ctrl: false, alt: false })}
            onShortcut={onShortcut}
            // Following the agent never pulls the keyboard; a pick by hand
            // focuses only if the viewer may drive (the page checks the wheel).
            focusOnAttach={quietSwitch ? "never" : "auto"}
            labels={paneLabels}
            onAction={(tid, action) => {
              const old = byId.get(tid)
              if (action === "restart")
                void createSession(old?.kind === "claude" ? "claude" : "shell")
              else select(docked.find((s) => s.terminalId !== tid)?.terminalId ?? null)
            }}
          />
        </View>
      </>
    )
  } else {
    body = <View style={{ flex: 1, backgroundColor: K.canvas }} />
  }

  return (
    <View
      style={{ flex: 1, backgroundColor: K.canvas }}
      onLayout={onLayout}
      testID="terminal-crew-window"
    >
      <View style={{ flex: 1, flexDirection: side === "left" ? "row" : "row-reverse" }}>
        {rail}
        <View style={{ flex: 1, minWidth: 0 }}>
          {body}
          {menuOpen ? (
            <CrewMenu
              entries={menuEntries}
              footer={menuFooter}
              onClose={() => {
                setMenuOpen(false)
                pane.current?.focus()
              }}
            />
          ) : null}
          {confirmClose && byId.get(confirmClose.id) ? (
            <CloseConfirm
              session={byId.get(confirmClose.id) as TerminalSession}
              reason={confirmClose.reason}
              onCancel={() => setConfirmClose(null)}
              onConfirm={() => {
                const id = confirmClose.id
                setConfirmClose(null)
                // Undo still holds: the session keeps running, hidden, until the window passes.
                closeNow(id, true)
              }}
            />
          ) : null}
        </View>
        {railDrag !== null ? (
          <View
            pointerEvents="none"
            style={[
              {
                position: "absolute",
                top: 8,
                bottom: 8,
                width: railW,
                [side === "left" ? "right" : "left"]: 8,
                zIndex: 20,
                borderRadius: 12,
                borderWidth: 2,
                borderStyle: railDrag ? "solid" : "dashed",
                borderColor: railDrag ? K.text : K.dim,
                backgroundColor: railDrag ? K.dropWashActive : K.dropWash,
                alignItems: "center",
                justifyContent: "center",
                padding: 6,
              },
            ]}
            testID="crew-side-dropzone"
          >
            <Text
              style={{
                fontFamily: SANS,
                fontSize: 11,
                fontWeight: "600",
                color: K.text,
                textAlign: "center",
              }}
            >
              {t("terminal.crew.dropHere", { defaultValue: "Drop here" })}
            </Text>
          </View>
        ) : null}
      </View>
      {touch && shownId ? (
        <ExtraKeysBar
          ctrl={mods.ctrl}
          alt={mods.alt}
          bottomInset={keyboardHeight}
          onKey={(seq) => {
            pane.current?.input(seq)
            setMods({ ctrl: false, alt: false })
          }}
          onModifier={(m) => {
            const next = !mods[m]
            setMods((prev) => ({ ...prev, [m]: next }))
            pane.current?.setModifier(m, next)
          }}
        />
      ) : null}
    </View>
  )
}

/** The header of a terminal whose create is still in flight. */
function OpeningHeader({ terminalId }: { terminalId: string }) {
  const { t } = useTranslation()
  const K = useK()
  return (
    <View
      style={{
        height: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingLeft: 12,
        borderBottomWidth: 1,
        borderBottomColor: K.line,
        backgroundColor: K.rail,
      }}
    >
      <Face terminalId={terminalId} state="idle" size={24} dim />
      <Text style={{ fontFamily: SANS, fontSize: 12.5, color: K.text2 }}>
        {t("terminal.opening", { defaultValue: "Opening…" })}
      </Text>
    </View>
  )
}

/** No terminal yet: what this window is, and the two ways to start one. */
function CrewEmpty({
  canCreate,
  onShell,
  onClaude,
}: {
  canCreate: boolean
  onShell: () => void
  onClaude: () => void
}) {
  const K = useK()
  const { t } = useTranslation()
  const btn = (label: string, icon: string, onPress: () => void, pri: boolean, testID: string) => (
    <Pressable
      disabled={!canCreate}
      onPress={onPress}
      style={({ hovered }: any) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        height: 32,
        paddingHorizontal: 12,
        borderRadius: 9,
        backgroundColor: pri ? K.btnPri : K.btn,
        opacity: !canCreate ? 0.5 : hovered ? 0.9 : 1,
      })}
      testID={testID}
    >
      <Ph name={icon} size={14} color={pri ? K.ink : K.textHi} />
      <Text
        style={{
          fontFamily: SANS,
          fontSize: 12.5,
          fontWeight: "500",
          color: pri ? K.ink : K.textHi,
        }}
      >
        {label}
      </Text>
    </Pressable>
  )
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: K.canvas,
        padding: 24,
        gap: 14,
      }}
      testID="crew-empty"
    >
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 4 }}>
        {(["work", "idle", "done"] as const).map((st, i) => (
          <View
            key={st}
            style={[{ opacity: 0.3 + i * 0.12 }, css({ transform: `rotate(${(i - 1) * 6}deg)` })]}
          >
            <Face terminalId={`empty-${i + 1}`} state={st} size={36} />
          </View>
        ))}
      </View>
      <Text style={{ fontFamily: SANS, fontSize: 15, fontWeight: "600", color: K.text }}>
        {t("terminal.crew.emptyTitle", { defaultValue: "No terminals yet" })}
      </Text>
      <Text
        style={{
          fontFamily: SANS,
          fontSize: 12.5,
          lineHeight: 18,
          color: K.dim,
          textAlign: "center",
          maxWidth: 340,
        }}
      >
        {t("terminal.crew.emptyText", {
          defaultValue:
            "Open a shell or a Claude Code. When an agent opens one, it shows up here with its face, and you see who is at the wheel.",
        })}
      </Text>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
        {btn(
          t("terminal.newShell", { defaultValue: "Shell" }),
          "terminal-window",
          onShell,
          false,
          "crew-empty-shell",
        )}
        {btn("Claude Code", "sparkle", onClaude, true, "crew-empty-claude")}
      </View>
    </View>
  )
}

/** Every terminal floats: the pane says where they are. */
function AllFloating({ sessions }: { sessions: TerminalSession[] }) {
  const { t } = useTranslation()
  const K = useK()
  const first = sessions[0]
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: K.canvas,
        gap: 12,
        padding: 24,
      }}
      testID="crew-all-floating"
    >
      <Ph name="picture-in-picture" size={26} color={K.dim} />
      <Text
        style={{
          fontFamily: SANS,
          fontSize: 13,
          color: K.text2,
          textAlign: "center",
          maxWidth: 320,
        }}
      >
        {t("terminal.crew.allFloating", {
          defaultValue: "Your terminals are floating. Drop one on the crew to bring it back here.",
        })}
      </Text>
      {first ? (
        <Pressable
          onPress={() => terminalFloat.dock(first.terminalId)}
          style={({ hovered }: any) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 7,
            height: 30,
            paddingHorizontal: 11,
            borderRadius: 8,
            backgroundColor: K.btn,
            opacity: hovered ? 0.9 : 1,
          })}
          testID="crew-dock-first"
        >
          <Ph name="arrow-line-down" size={13} color={K.textHi} />
          <Text style={{ fontFamily: SANS, fontSize: 12, color: K.textHi }}>
            {t("terminal.crew.dockOne", {
              defaultValue: "Bring {{name}} back",
              name: sessionLabel(first),
            })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

// The tiny helper the header's co-pilot label uses lives in crewModel; re-exported for tests.
export { firstName }
