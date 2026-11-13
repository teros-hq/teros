import { router } from "expo-router"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import {
  floatTerminalSession,
  showTerminalSession,
} from "../../windows/TerminalWindow/terminalSessions"

const SWITCH_TIMEOUT_MS = 15_000
const SETTLE_MS = 600

export type OpenMode = "tab" | "float"

function isReady(workspaceId: string): boolean {
  if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return false
  return useTilingStore.getState().layoutRestoredForWorkspace === workspaceId
}

function whenReady(workspaceId: string): Promise<boolean> {
  if (isReady(workspaceId)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const check = () => {
      if (isReady(workspaceId)) done(true)
    }
    const unsubs = [useWorkspaceStore.subscribe(check), useTilingStore.subscribe(check)]
    const timer = setTimeout(() => done(false), SWITCH_TIMEOUT_MS)
    function done(ok: boolean) {
      clearTimeout(timer)
      for (const u of unsubs) u()
      resolve(ok)
    }
  })
}

async function settled(workspaceId: string): Promise<boolean> {
  const deadline = Date.now() + SWITCH_TIMEOUT_MS
  for (;;) {
    if (!(await whenReady(workspaceId))) return false
    const gen = useTilingStore.getState().restoreGeneration
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    if (useTilingStore.getState().restoreGeneration === gen && isReady(workspaceId)) return true
    if (Date.now() > deadline) return false
  }
}

export async function openTerminalNeed(
  workspaceId: string | null | undefined,
  terminalId: string,
  mode: OpenMode = "tab",
): Promise<void> {
  if (workspaceId) {
    const switched = useWorkspaceStore.getState().activeWorkspaceId !== workspaceId
    if (switched) router.replace(`/workspace/${workspaceId}`)
    const ready = switched ? await settled(workspaceId) : await whenReady(workspaceId)
    if (!ready) return
  }
  if (mode === "float") floatTerminalSession(workspaceId, terminalId)
  else showTerminalSession(workspaceId, terminalId)
}
