import { useEffect } from "react"
import { frontId } from "../../../store/floatGeometry"
import { useTilingStore } from "../../../store/tilingStore"

interface KeyLike {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export function isFloatShortcut(event: KeyLike, mac: boolean): boolean {
  if (event.code !== "KeyF" || !event.shiftKey) return false
  if (mac) return event.metaKey && !event.ctrlKey && !event.altKey
  return event.ctrlKey && event.altKey && !event.metaKey
}

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

export function toggleFloat(windowId: string): void {
  const tiling = useTilingStore.getState()
  if (tiling.floats[windowId]) tiling.dockWindow(windowId)
  else tiling.floatWindow(windowId)
}

function focusedFloat(): string | null {
  const active = document.activeElement
  const host = active?.closest?.("[data-float-window]")
  if (host) return host.getAttribute("data-float-window")
  if (active && active !== document.body) return null
  const tiling = useTilingStore.getState()
  return tiling.compactShell ? tiling.floatSheetId : frontId(tiling.floats)
}

function activeTab(): string | null {
  const tiling = useTilingStore.getState()
  const desktop = tiling.desktops[tiling.activeDesktopIndex]
  if (!desktop?.activeContainerId) return null
  return tiling.getContainer(desktop.activeContainerId)?.activeWindowId ?? null
}

export function useFloatShortcut(): void {
  useEffect(() => {
    const mac = isMac()
    const onKey = (event: KeyboardEvent) => {
      if (!isFloatShortcut(event, mac)) return
      const target = focusedFloat() ?? activeTab()
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      toggleFloat(target)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])
}
