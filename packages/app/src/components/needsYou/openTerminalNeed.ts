/**
 * "Abrir flotando" / "Ir a la terminal" from a notice, for a session in any
 * of the person's workspaces. Terminal windows and floating terminals belong
 * to the active workspace, so a session elsewhere switches workspace first
 * (URL-first, like the navbar's switcher) and acts once that workspace's
 * layout — and, to float, its floating windows — have been restored: acting
 * earlier would be wiped by the in-flight restore. The route change restores
 * the layout a second time (the shell remounts), so it also waits for the
 * restores to settle.
 */

import { router } from "expo-router"
import { Platform } from "react-native"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { terminalFloat, useTerminalFloatStore } from "../../windows/TerminalWindow/floating"
import { showTerminalSession } from "../../windows/TerminalWindow/terminalSessions"

export type OpenHow = "float" | "terminal"

const SWITCH_TIMEOUT_MS = 15_000
/** No new restore for this long after a switch: the layout has settled. */
const SETTLE_MS = 600

function isReady(workspaceId: string, how: OpenHow, switched: boolean): boolean {
  if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return false
  if (useTilingStore.getState().layoutRestoredForWorkspace !== workspaceId) return false
  // Floating windows load after the layout (web only; native has none to restore).
  if (how === "float" && switched && Platform.OS === "web") {
    return useTerminalFloatStore.getState().hydratedFor === workspaceId
  }
  return true
}

/** Resolves true once the workspace is on screen and ready for the action, false on timeout. */
function whenReady(workspaceId: string, how: OpenHow, switched: boolean): Promise<boolean> {
  if (isReady(workspaceId, how, switched)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const check = () => {
      if (isReady(workspaceId, how, switched)) done(true)
    }
    const unsubs = [
      useWorkspaceStore.subscribe(check),
      useTilingStore.subscribe(check),
      useTerminalFloatStore.subscribe(check),
    ]
    const timer = setTimeout(() => done(false), SWITCH_TIMEOUT_MS)
    function done(ok: boolean) {
      clearTimeout(timer)
      for (const u of unsubs) u()
      resolve(ok)
    }
  })
}

/** After a switch: ready, and no restore landed for SETTLE_MS. */
async function settled(workspaceId: string, how: OpenHow): Promise<boolean> {
  const deadline = Date.now() + SWITCH_TIMEOUT_MS
  for (;;) {
    if (!(await whenReady(workspaceId, how, true))) return false
    const gen = useTilingStore.getState().restoreGeneration
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    if (useTilingStore.getState().restoreGeneration === gen && isReady(workspaceId, how, true))
      return true
    if (Date.now() > deadline) return false
  }
}

/** Show a session from a notice: floating over the desktop, or in its Terminal window. */
export async function openTerminalNeed(
  workspaceId: string | null | undefined,
  terminalId: string,
  how: OpenHow,
): Promise<void> {
  if (workspaceId) {
    const switched = useWorkspaceStore.getState().activeWorkspaceId !== workspaceId
    if (switched) router.replace(`/workspace/${workspaceId}`)
    const ready = switched
      ? await settled(workspaceId, how)
      : await whenReady(workspaceId, how, false)
    if (!ready) return
  }
  if (how === "float") terminalFloat.popOut(terminalId)
  else showTerminalSession(workspaceId, terminalId)
}
