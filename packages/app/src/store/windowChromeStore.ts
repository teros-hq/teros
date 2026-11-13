import { useEffect, useRef } from "react"
import { create } from "zustand"

export interface WindowFace {
  id: string
  name: string
  imageUrl?: string | null
  agent?: boolean
}

export interface WindowTabIcon {
  icon?: string
  face?: WindowFace
  tone?: "accent"
  pulse?: boolean
  tooltip?: string
}

export interface WindowTabMark {
  id: string
  label: string
  icon: string
  count?: number
  faces?: WindowFace[]
}

export interface WindowMenuEntry {
  id: string
  label: string
  icon?: string
  detail?: string
  trailing?: string
  shortcut?: string
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  separated?: boolean
  onPress: () => void
}

export interface WindowMenu {
  caption?: string
  entries: WindowMenuEntry[]
}

export interface WindowTitleEdit {
  initial: string
  onDone: (title: string | null) => void
}

export interface WindowCloseQuestion {
  message: string
  confirmLabel: string
  keepLabel: string
  onConfirm: () => void
  onKeep?: () => void
}

export interface WindowChrome {
  icon?: WindowTabIcon | null
  marks?: WindowTabMark[]
  ring?: boolean
  menu?: WindowMenu | null
  titleEdit?: WindowTitleEdit | null
  closeGuard?: (() => WindowCloseQuestion | null) | null
  onClose?: (() => void) | null
}

interface WindowChromeState {
  chrome: Record<string, WindowChrome>
  closing: Record<string, WindowCloseQuestion>
  setChrome: (windowId: string, chrome: WindowChrome | null) => void
  setClosing: (windowId: string, question: WindowCloseQuestion | null) => void
}

export const NO_CHROME: WindowChrome = Object.freeze({})

function withEntry<T>(map: Record<string, T>, key: string, value: T | null): Record<string, T> {
  const next = { ...map }
  if (value) next[key] = value
  else delete next[key]
  return next
}

export const useWindowChromeStore = create<WindowChromeState>()((set) => ({
  chrome: {},
  closing: {},
  setChrome: (windowId, chrome) =>
    set((state) => {
      if (!chrome && !state.chrome[windowId]) return state
      return { chrome: withEntry(state.chrome, windowId, chrome) }
    }),
  setClosing: (windowId, question) =>
    set((state) => {
      if (!question && !state.closing[windowId]) return state
      return { closing: withEntry(state.closing, windowId, question) }
    }),
}))

function signatureOf(chrome: WindowChrome | null): string {
  return JSON.stringify(chrome, (_key, value) => (typeof value === "function" ? undefined : value))
}

export function useWindowChrome(windowId: string | undefined, chrome: WindowChrome | null): void {
  const latest = useRef(chrome)
  latest.current = chrome
  const signature = signatureOf(chrome)
  useEffect(() => {
    if (!windowId) return
    const now = latest.current
    if (!now) {
      useWindowChromeStore.getState().setChrome(windowId, null)
      return
    }
    const menu = now.menu
      ? {
          ...now.menu,
          entries: now.menu.entries.map((entry) => ({
            ...entry,
            onPress: () => latest.current?.menu?.entries.find((e) => e.id === entry.id)?.onPress(),
          })),
        }
      : null
    const titleEdit = now.titleEdit
      ? {
          initial: now.titleEdit.initial,
          onDone: (title: string | null) => latest.current?.titleEdit?.onDone(title),
        }
      : null
    const closeGuard = () => latest.current?.closeGuard?.() ?? null
    const onClose = () => latest.current?.onClose?.()
    useWindowChromeStore
      .getState()
      .setChrome(windowId, { ...now, menu, titleEdit, closeGuard, onClose })
  }, [windowId, signature])
  useEffect(() => {
    if (!windowId) return
    return () => useWindowChromeStore.getState().setChrome(windowId, null)
  }, [windowId])
}

export function useWindowClosing(windowId: string): WindowCloseQuestion | null {
  return useWindowChromeStore((state) => state.closing[windowId] ?? null)
}

export function useWindowChromeOf(windowId: string | null | undefined): WindowChrome {
  return useWindowChromeStore((state) => (windowId && state.chrome[windowId]) || NO_CHROME)
}
