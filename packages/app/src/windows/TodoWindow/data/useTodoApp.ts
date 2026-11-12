/**
 * Resolve the todo-list app of a workspace (audit F5: re-resolves when the
 * active workspace changes instead of latching "not installed").
 */
import { useEffect, useState } from "react"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { useWorkspaceStore } from "../../../store/workspaceStore"

export type TodoAppStatus = "resolving" | "ready" | "notInstalled" | "noWorkspace" | "error"

const MCA_ID = "mca.teros.todo-list"
const cache = new Map<string, string | null>()

export function useTodoApp(props: { workspaceId?: string; appId?: string }) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const workspaceId = props.workspaceId ?? activeWorkspaceId ?? null
  const [state, setState] = useState<{ status: TodoAppStatus; appId: string | null; ws: string | null }>(() => {
    if (props.appId) return { status: "ready", appId: props.appId, ws: workspaceId }
    if (workspaceId && cache.has(workspaceId)) {
      const id = cache.get(workspaceId) ?? null
      return { status: id ? "ready" : "notInstalled", appId: id, ws: workspaceId }
    }
    return { status: "resolving", appId: null, ws: workspaceId }
  })

  useEffect(() => {
    if (props.appId) {
      setState({ status: "ready", appId: props.appId, ws: workspaceId })
      return
    }
    if (!workspaceId) {
      setState({ status: "noWorkspace", appId: null, ws: null })
      return
    }
    let cancelled = false
    if (cache.has(workspaceId)) {
      const id = cache.get(workspaceId) ?? null
      setState({ status: id ? "ready" : "notInstalled", appId: id, ws: workspaceId })
    } else {
      setState({ status: "resolving", appId: null, ws: workspaceId })
    }
    getTerosClient()
      .workspace.listWorkspaceApps(workspaceId)
      .then(({ apps }: { apps: Array<{ appId: string; mcaId: string }> }) => {
        if (cancelled) return
        const found = apps.find((a) => a.mcaId === MCA_ID)
        cache.set(workspaceId, found?.appId ?? null)
        setState({ status: found ? "ready" : "notInstalled", appId: found?.appId ?? null, ws: workspaceId })
      })
      .catch(() => {
        if (!cancelled && !cache.has(workspaceId)) setState({ status: "error", appId: null, ws: workspaceId })
      })
    return () => {
      cancelled = true
    }
  }, [props.appId, workspaceId])

  return { ...state, workspaceId }
}
