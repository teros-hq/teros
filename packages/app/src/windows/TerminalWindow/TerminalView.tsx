/**
 * TerminalView — one terminal pane: the xterm page (terminalBundle) in an
 * iframe (web) or WebView (native), attached to one session.
 *
 * The page opens its own WebSocket to /ws/terminal; this component only
 * brokers tickets (terminal.ticket on the app's main socket), switches the
 * attached session, and relays what the page reports (presence, agent state,
 * connection status, exit, latency) to the window.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react"
import { Platform, View } from "react-native"
import type { WebViewMessageEvent } from "react-native-webview"
import RawWebView from "react-native-webview"
import { getTerosClient } from "../../services/terosClientSingleton"
import { terminalHtml } from "./terminalBundle"

// Cast to accept props on all platforms (RN-web type resolution issue)
const WebView = RawWebView as any

export type ConnStatus = "connecting" | "live" | "offline" | "ended" | "denied"

export interface PaneLiveState {
  status: ConnStatus
  detail?: string
  typing: { kind: "human" | "agent"; id: string; name?: string; at: number } | null
  watchers: string[]
  title?: string
  echoP50?: number | null
  rttMs?: number | null
}

export type WindowShortcut =
  | "prev-session"
  | "next-session"
  | "take-wheel"
  | "float"
  | "rail-left"
  | "rail-right"

const SHORTCUTS: readonly string[] = [
  "prev-session",
  "next-session",
  "take-wheel",
  "float",
  "rail-left",
  "rail-right",
]

export interface TerminalViewHandle {
  input(data: string): void
  setModifier(modifier: "ctrl" | "alt", active: boolean): void
  focus(): void
  clear(): void
}

interface Props {
  terminalId: string
  theme: "dark" | "light"
  optionIsMeta: boolean
  background: string
  onLive: (terminalId: string, patch: Partial<PaneLiveState>) => void
  onFocus?: () => void
  onModifierReset?: () => void
  onBell?: (terminalId: string) => void
  /** A window shortcut typed in the terminal (Cmd+Shift+[ / ], ⌘⇧K, ⌘⇧F, ⌥⌘[ / ]). */
  onShortcut?: (action: WindowShortcut) => void
  /**
   * Take the keyboard focus when attaching. "auto" (default): the page decides
   * once it knows who drives — it focuses only when the viewer may type (an
   * agent at the wheel keeps the pane read-only and unfocused). "never": the
   * window switched sessions on its own (following the agent); the person may
   * be typing in the chat next to it.
   */
  focusOnAttach?: "auto" | "never"
  /** The page's own buttons on a pane state ("Session ended · Restart · Close"). */
  onAction?: (terminalId: string, action: "restart" | "close") => void
  /** Translated pane-state strings for the page (English defaults there). */
  labels?: Record<string, string>
}

/** /ws/terminal on the backend the app is connected to. */
export function terminalWsUrl(): string {
  const base = getTerosClient()?.getBackendBaseUrl() ?? ""
  return `${base.replace(/^http/, "ws")}/ws/terminal`
}

export const TerminalView = forwardRef<TerminalViewHandle, Props>(function TerminalView(
  {
    terminalId,
    theme,
    optionIsMeta,
    background,
    onLive,
    onFocus,
    onModifierReset,
    onBell,
    onShortcut,
    focusOnAttach = "auto",
    onAction,
    labels,
  },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const webViewRef = useRef<any>(null)
  const readyRef = useRef(false)
  const attachedRef = useRef<string | null>(null)
  const latest = useRef({
    terminalId,
    theme,
    optionIsMeta,
    onLive,
    onFocus,
    onModifierReset,
    onBell,
    onShortcut,
    focusOnAttach,
    onAction,
    labels,
  })
  latest.current = {
    terminalId,
    theme,
    optionIsMeta,
    onLive,
    onFocus,
    onModifierReset,
    onBell,
    onShortcut,
    focusOnAttach,
    onAction,
    labels,
  }

  const post = useCallback((msg: object) => {
    const data = JSON.stringify(msg)
    if (Platform.OS === "web") {
      iframeRef.current?.contentWindow?.postMessage(data, window.origin)
    } else {
      webViewRef.current?.injectJavaScript(
        `window.terosTerminal && window.terosTerminal.receive(${JSON.stringify(data)}); true;`,
      )
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      input: (data) => post({ type: "input", data }),
      setModifier: (modifier, active) => post({ type: "set_modifier", modifier, active }),
      focus: () => post({ type: "focus" }),
      clear: () => post({ type: "clear" }),
    }),
    [post],
  )

  const onPageMessage = useCallback(
    (raw: string) => {
      let msg: any
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      const cur = latest.current
      const id = attachedRef.current ?? cur.terminalId
      switch (msg.type) {
        case "ready":
          readyRef.current = true
          attachedRef.current = cur.terminalId
          post({
            type: "init",
            wsUrl: terminalWsUrl(),
            terminalId: cur.terminalId,
            theme: cur.theme,
            optionIsMeta: cur.optionIsMeta,
            focus: cur.focusOnAttach === "auto",
            labels: cur.labels,
          })
          break
        case "need_ticket":
          getTerosClient()
            ?.send("terminal", "ticket", {})
            .then((res: any) => post({ type: "ticket", ticket: res.ticket }))
            .catch((err: unknown) =>
              cur.onLive(id, {
                status: "offline",
                detail: err instanceof Error ? err.message : String(err),
              }),
            )
          break
        case "status":
          cur.onLive(id, { status: msg.conn, detail: msg.detail })
          break
        case "state":
          cur.onLive(id, { typing: msg.typing ?? null, watchers: msg.watchers ?? [] })
          break
        case "title":
          cur.onLive(id, { title: msg.title })
          break
        case "stats":
          cur.onLive(id, { echoP50: msg.echoP50, rttMs: msg.rttMs })
          break
        case "exit":
          cur.onLive(id, { status: "ended" })
          break
        case "bell":
          cur.onBell?.(id)
          break
        case "focused":
          cur.onFocus?.()
          break
        case "modifier_reset":
          cur.onModifierReset?.()
          break
        case "action":
          if (msg.action === "restart" || msg.action === "close") cur.onAction?.(id, msg.action)
          break
        case "shortcut":
          if (SHORTCUTS.includes(msg.action)) cur.onShortcut?.(msg.action)
          break
      }
    },
    [post],
  )

  // Switch the pane to another session without reloading the page.
  useEffect(() => {
    if (!readyRef.current || attachedRef.current === terminalId) return
    attachedRef.current = terminalId
    post({ type: "attach", terminalId, focus: latest.current.focusOnAttach === "auto" })
  }, [terminalId, post])

  useEffect(() => {
    if (readyRef.current) post({ type: "options", theme, optionIsMeta })
  }, [theme, optionIsMeta, post])

  // Web: messages from our own iframe only.
  useEffect(() => {
    if (Platform.OS !== "web") return
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      onPageMessage(typeof e.data === "string" ? e.data : JSON.stringify(e.data))
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [onPageMessage])

  if (Platform.OS === "web") {
    return (
      <View style={{ flex: 1, backgroundColor: background }}>
        <iframe
          ref={iframeRef}
          srcDoc={terminalHtml}
          title={`terminal-${terminalId}`}
          data-testid="terminal-iframe"
          allow="clipboard-read; clipboard-write"
          style={{ flex: 1, border: "none", width: "100%", height: "100%", background }}
        />
      </View>
    )
  }
  return (
    <WebView
      ref={webViewRef}
      source={{ html: terminalHtml }}
      onMessage={(e: WebViewMessageEvent) => onPageMessage(e.nativeEvent.data)}
      javaScriptEnabled
      scrollEnabled={false}
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView
      style={{ flex: 1, backgroundColor: background }}
      originWhitelist={["*"]}
    />
  )
})
