/**
 * /ws/terminal frames (see packages/backend/src/services/terminal/stream-server.ts)
 * and the bridge between this page and the Terminal window (postMessage on
 * the web, ReactNativeWebView on native).
 */

export const KIND_OUTPUT = 1
export const KIND_SNAPSHOT = 2

export interface BinaryFrame {
  kind: number
  id: string
  payload: Uint8Array
}

export function decodeFrame(buf: ArrayBuffer): BinaryFrame | null {
  const bytes = new Uint8Array(buf)
  if (bytes.length < 2) return null
  const idLen = bytes[1]
  if (bytes.length < 2 + idLen) return null
  return {
    kind: bytes[0],
    id: new TextDecoder().decode(bytes.subarray(2, 2 + idLen)),
    payload: bytes.subarray(2 + idLen),
  }
}

export type ThemeMode = "dark" | "light"

/** Texts of the pane states the page draws over the terminal. */
export interface PaneLabels {
  starting: string
  reconnecting: string
  retry: string
  ended: string
  restart: string
  close: string
  denied: string
  jump: string
  /** Read-only pane: who drives, and the way out. */
  readOnly: string
  takeWheel: string
}

export const DEFAULT_LABELS: PaneLabels = {
  starting: "Starting…",
  reconnecting: "Reconnecting…",
  retry: "Retry",
  ended: "Session ended",
  restart: "Restart",
  close: "Close",
  denied: "You don't have access to this session",
  jump: "Jump to the bottom",
  readOnly: "{{name}} has the wheel — view only",
  takeWheel: "Take the wheel",
}

export interface SessionSummary {
  terminalId: string
  title?: string
  kind?: string
  command?: string | null
  pinned?: boolean
  persistent?: boolean
  agentState?: { state: string; message?: string } | null
  /** Who holds the wheel (crew contract): the page stays read-only while an
   *  agent (or someone else) drives, and says so instead of sending keys. */
  driver?: { kind: "agent" | "human" | "none"; id?: string; name?: string } | null
}

export interface Typist {
  kind: "human" | "agent"
  id: string
  name?: string
  at: number
}

/** Window → page. */
export type ParentMessage =
  | {
      type: "init"
      wsUrl: string
      terminalId: string
      theme: ThemeMode
      fontSize?: number
      optionIsMeta?: boolean
      /** Take the keyboard focus once attached (default true). */
      focus?: boolean
      /** Translated texts of the page's own UI (pane states); English defaults. */
      labels?: Partial<PaneLabels>
    }
  | { type: "ticket"; ticket: string }
  /** focus false: switched by the window (following the agent), keep the focus where it is. */
  | { type: "attach"; terminalId: string; focus?: boolean }
  | { type: "input"; data: string }
  | { type: "set_modifier"; modifier: "ctrl" | "alt"; active: boolean }
  | {
      type: "options"
      theme?: ThemeMode
      fontSize?: number
      optionIsMeta?: boolean
      labels?: Partial<PaneLabels>
    }
  | { type: "focus" }
  | { type: "clear" }

/** Page → window. */
export type PageMessage =
  | { type: "ready" }
  | { type: "need_ticket" }
  | {
      type: "status"
      conn: "connecting" | "live" | "offline" | "ended" | "denied"
      detail?: string
    }
  | { type: "state"; session: SessionSummary | null; typing: Typist | null; watchers: string[] }
  | { type: "exit"; code: number; reason?: string }
  | { type: "title"; title: string }
  | { type: "bell" }
  | { type: "modifier_reset" }
  | { type: "focused" }
  /** A window shortcut typed in the terminal (switch sessions, wheel, float, rail side). */
  | {
      type: "shortcut"
      action: "prev-session" | "next-session" | "take-wheel" | "float" | "rail-left" | "rail-right"
    }
  /** A pane-state button: start the session again / take it off screen. */
  | { type: "action"; action: "restart" | "close" }
  | {
      type: "stats"
      rttMs: number | null
      echoP50: number | null
      echoP95: number | null
      bytesIn: number
      resyncs: number
    }

export function parseMessage<T>(raw: unknown): T | null {
  try {
    const msg = typeof raw === "string" ? JSON.parse(raw) : raw
    return msg && typeof msg === "object" && "type" in msg ? (msg as T) : null
  } catch {
    return null
  }
}
