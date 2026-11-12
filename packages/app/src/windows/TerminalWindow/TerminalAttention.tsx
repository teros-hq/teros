/**
 * TerminalAttention — "a coding agent needs you" from anywhere in the app.
 *
 * Mounted once in the workspace layout. Watches the active workspace's
 * terminal sessions; when an agent in one of them becomes blocked (permission
 * prompt, question) or finishes its turn, it shows a toast with an Open action
 * — unless that session is already on screen in the focused window — and keeps
 * the Terminal windows' badge at the number of sessions waiting for you.
 */

import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useToast } from "../../components/Toast"
import { useNavbarStore } from "../../store/navbarStore"
import type { LayoutNode } from "../../store/tilingStore"
import { selectActiveContainerId, selectLayout, useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { sessionLabel, showTerminalSession, useTerminalSessions } from "./terminalSessions"

function containerOf(
  node: LayoutNode | null,
  windowId: string,
): { id: string; activeWindowId: string | null } | null {
  if (!node) return null
  if (node.type === "container") return node.windowIds.includes(windowId) ? node : null
  return containerOf(node.first, windowId) ?? containerOf(node.second, windowId)
}

/** Is this session on screen in the window the user is looking at? */
function onScreen(terminalId: string): boolean {
  if (typeof document !== "undefined" && (document.hidden || !document.hasFocus?.())) return false
  const state = useTilingStore.getState()
  const layout = selectLayout(state)
  const activeContainer = selectActiveContainerId(state)
  for (const win of Object.values(state.windows)) {
    if (win.type !== "terminal") continue
    if (win.props?.active !== terminalId && win.props?.split !== terminalId) continue
    const container = containerOf(layout, win.id)
    if (container?.activeWindowId === win.id && container.id === activeContainer) return true
  }
  return false
}

export function TerminalAttention() {
  const { t } = useTranslation()
  const toast = useToast()
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const role = useNavbarStore((s) => s.workspaces.find((w) => w.workspaceId === workspaceId)?.role)
  const { sessions, loaded } = useTerminalSessions(
    workspaceId && role !== "read" ? workspaceId : null,
  )
  const seen = useRef(new Map<string, string>())
  const lastCount = useRef(-1)

  useEffect(() => {
    if (!loaded) return
    for (const s of sessions) {
      const key = s.agentState ? `${s.agentState.state}@${s.agentState.at}` : ""
      const prev = seen.current.get(s.terminalId)
      seen.current.set(s.terminalId, key)
      // First sight (page load): badge it, but don't toast old news.
      if (prev === undefined || prev === key || !s.agentState) continue
      const state = s.agentState.state
      if (state !== "blocked" && state !== "done") continue
      // "Finished" only after a turn actually ran (Claude's idle reminder also reports done).
      const before = prev.split("@")[0]
      if (state === "done" && before !== "working" && before !== "blocked") continue
      if (onScreen(s.terminalId)) continue
      const open = () => showTerminalSession(workspaceId, s.terminalId)
      const title =
        state === "blocked"
          ? t("terminal.attentionBlocked", {
              defaultValue: "{{name}} needs you",
              name: sessionLabel(s),
            })
          : t("terminal.attentionDone", {
              defaultValue: "{{name}} finished",
              name: sessionLabel(s),
            })
      toast.show(title, {
        message: s.agentState.message,
        type: state === "blocked" ? "warning" : "success",
        duration: state === "blocked" ? 15_000 : 6_000,
        action: { label: t("terminal.open", { defaultValue: "Open" }), onPress: open },
      })
    }
    for (const id of [...seen.current.keys()]) {
      if (!sessions.some((s) => s.terminalId === id)) seen.current.delete(id)
    }

    // Badge: sessions blocked on the user, on every Terminal window.
    const waiting = sessions.filter((s) => s.agentState?.state === "blocked").length
    if (waiting === lastCount.current) return
    lastCount.current = waiting
    const tiling = useTilingStore.getState()
    for (const win of Object.values(tiling.windows)) {
      if (win.type !== "terminal") continue
      if (waiting > 0) tiling.setWindowNotification(win.id, true, waiting)
      else tiling.clearWindowNotification(win.id)
    }
  }, [sessions, loaded, workspaceId, t, toast])

  return null
}
