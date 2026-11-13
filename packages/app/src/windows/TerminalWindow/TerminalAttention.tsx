import type { MemberRole } from "@teros/shared"
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { type ToastAction, useToast } from "../../components/Toast"
import { useAuthStore } from "../../store/authStore"
import { useNavbarStore } from "../../store/navbarStore"
import { floatsSupported } from "../../store/tilingFloats"
import { isWindowOnScreen, useTilingStore } from "../../store/tilingStore"
import { setWindowStatus } from "../../store/windowTabMetaStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import {
  isAskedToUse,
  isBlockedOn,
  markFinished,
  mayUse,
  sessionStatus,
  useSessionMarks,
} from "./sessionStatus"
import { agentDisplayName } from "./sessionText"
import {
  floatTerminalSession,
  onSessionRevealed,
  sessionLabel,
  showTerminalSession,
  type TerminalSession,
  useTerminalSessions,
} from "./terminalSessions"

function looking(): boolean {
  return typeof document === "undefined" || (!document.hidden && document.hasFocus?.() !== false)
}

function onScreen(terminalId: string): boolean {
  if (!looking()) return false
  const state = useTilingStore.getState()
  return Object.values(state.windows).some(
    (win) =>
      win.type === "terminal" &&
      win.props?.terminalId === terminalId &&
      isWindowOnScreen(state, win.id),
  )
}

function stateKey(s: TerminalSession): string {
  return s.agentState ? `${s.agentState.state}@${s.agentState.at}` : ""
}

function requestKey(s: TerminalSession): string {
  return s.wheelRequest ? `${s.wheelRequest.agent.id}@${s.wheelRequest.at}` : ""
}

type Call = "blocked" | "done" | "request"

function callOf(
  s: TerminalSession,
  prev: { state: string; request: string } | undefined,
  me: string | undefined,
  role: MemberRole,
): Call | null {
  if (!prev) return null
  const request = requestKey(s)
  if (request && request !== prev.request && isAskedToUse(s, me, role)) return "request"
  if (stateKey(s) === prev.state || !s.agentState) return null
  if (s.agentState.state === "blocked") return isBlockedOn(s, me, role) ? "blocked" : null
  if (s.agentState.state !== "done" || !mayUse(s, me, role)) return null
  const before = prev.state.split("@")[0]
  return before === "working" || before === "blocked" ? "done" : null
}

export function TerminalAttention() {
  const { t } = useTranslation()
  const toast = useToast()
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const me = useAuthStore((s) => s.user?.userId)
  const role = useNavbarStore((s) => s.workspaces.find((w) => w.workspaceId === workspaceId)?.role)
  const { sessions, loaded } = useTerminalSessions(
    workspaceId && role !== "read" ? workspaceId : null,
  )
  const windows = useTilingStore((s) => s.windows)
  const floats = useTilingStore((s) => s.floats)
  const desktops = useTilingStore((s) => s.desktops)
  const activeDesktop = useTilingStore((s) => s.activeDesktopIndex)
  const finished = useSessionMarks((s) => s.finished)
  const seen = useRef(new Map<string, { state: string; request: string }>())
  const published = useRef(new Set<string>())

  useEffect(() => {
    if (!loaded) return
    const floats = floatsSupported()
    const float: (id: string) => ToastAction = (id) => ({
      label: t("terminal.float", { defaultValue: "Float" }),
      onPress: () => {
        toast.hide()
        floatTerminalSession(workspaceId, id)
      },
    })
    const open: (id: string) => ToastAction = (id) => ({
      label: t("terminal.open", { defaultValue: "Open" }),
      onPress: () => {
        toast.hide()
        showTerminalSession(workspaceId, id)
      },
    })
    for (const s of sessions) {
      const id = s.terminalId
      const call = callOf(s, seen.current.get(id), me, role ?? "write")
      seen.current.set(id, { state: stateKey(s), request: requestKey(s) })
      if (s.agentState?.state !== "done") markFinished(id, false)
      if (!call || onScreen(id)) continue
      const name = sessionLabel(s)
      if (call === "done") {
        markFinished(id, true)
        toast.show(t("terminal.attentionDone", { defaultValue: "{{name}} finished", name }), {
          message: s.agentState?.message,
          type: "success",
          duration: 6_000,
          action: open(id),
          secondary: floats ? float(id) : undefined,
        })
        continue
      }
      const title =
        call === "request"
          ? t("terminal.attentionRequest", {
              defaultValue: "{{agent}} asks to use {{name}}",
              agent: agentDisplayName(s.wheelRequest?.agent),
              name,
            })
          : t("terminal.attentionBlocked", { defaultValue: "{{name}} needs you", name })
      toast.show(title, {
        message: call === "request" ? (s.wheelRequest?.reason ?? undefined) : s.agentState?.message,
        type: "warning",
        duration: 15_000,
        action: floats ? float(id) : open(id),
        secondary: floats ? open(id) : undefined,
      })
    }
    for (const id of [...seen.current.keys()]) {
      if (sessions.some((s) => s.terminalId === id)) continue
      seen.current.delete(id)
      markFinished(id, false)
    }
  }, [sessions, loaded, workspaceId, me, role, t, toast])

  useEffect(() => {
    const clear = () => {
      for (const id of Object.keys(useSessionMarks.getState().finished))
        if (onScreen(id)) markFinished(id, false)
    }
    clear()
    if (typeof window === "undefined") return
    window.addEventListener("focus", clear)
    return () => window.removeEventListener("focus", clear)
  }, [windows, floats, desktops, activeDesktop, finished])

  useEffect(() => {
    const byId = new Map(sessions.map((s) => [s.terminalId, s]))
    const next = new Set<string>()
    for (const win of Object.values(windows)) {
      if (win.type !== "terminal") continue
      const session = loaded ? byId.get(win.props?.terminalId) : undefined
      setWindowStatus(win.id, session ? sessionStatus(session, me, role ?? "write", finished) : null)
      next.add(win.id)
    }
    for (const id of published.current) if (!next.has(id)) setWindowStatus(id, null)
    published.current = next
  }, [sessions, loaded, windows, finished, me, role])

  useEffect(
    () => () => {
      for (const id of published.current) setWindowStatus(id, null)
    },
    [],
  )

  useEffect(
    () =>
      onSessionRevealed((revealedIn, session) => {
        if (revealedIn !== workspaceId || onScreen(session.terminalId)) return
        const floatIt: ToastAction = {
          label: t("terminal.float", { defaultValue: "Float" }),
          onPress: () => {
            toast.hide()
            floatTerminalSession(revealedIn, session.terminalId)
          },
        }
        const openIt: ToastAction = {
          label: t("terminal.open", { defaultValue: "Open" }),
          onPress: () => {
            toast.hide()
            showTerminalSession(revealedIn, session.terminalId)
          },
        }
        toast.show(
          t("terminal.window.agentShows", {
            defaultValue: "{{agent}} is working in {{name}}",
            agent: agentDisplayName(session.driver),
            name: sessionLabel(session),
          }),
          {
            type: "info",
            duration: 10_000,
            action: floatsSupported() ? floatIt : openIt,
            secondary: floatsSupported() ? openIt : undefined,
          },
        )
      }),
    [workspaceId, t, toast],
  )

  return null
}
