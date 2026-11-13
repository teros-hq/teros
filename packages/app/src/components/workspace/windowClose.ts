import { useTilingStore } from "../../store/tilingStore"
import { useWindowChromeStore } from "../../store/windowChromeStore"

export function requestCloseWindow(windowId: string): void {
  const tiling = useTilingStore.getState()
  if (!tiling.windows[windowId]) return
  const chromes = useWindowChromeStore.getState()
  const chrome = chromes.chrome[windowId]
  const question = chrome?.closeGuard?.() ?? null
  if (question) {
    tiling.focusWindow(windowId)
    chromes.setClosing(windowId, question)
    return
  }
  chrome?.onClose?.()
  tiling.closeWindow(windowId)
}

export function requestCloseWindows(windowIds: readonly string[], closeWhole: () => void): void {
  const chrome = useWindowChromeStore.getState().chrome
  if (!windowIds.some((id) => chrome[id]?.closeGuard || chrome[id]?.onClose)) {
    closeWhole()
    return
  }
  for (const id of [...windowIds]) requestCloseWindow(id)
}

export function answerClose(windowId: string, answer: "confirm" | "keep"): void {
  const chromes = useWindowChromeStore.getState()
  const question = chromes.closing[windowId]
  if (!question) return
  chromes.setClosing(windowId, null)
  if (answer === "confirm") question.onConfirm()
  else question.onKeep?.()
  useTilingStore.getState().closeWindow(windowId)
}
