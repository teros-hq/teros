/**
 * Teros Terminal page — xterm.js on a live session of the workspace's terminal host.
 *
 * Runs inside the Terminal window's iframe (web) or WebView (native). It
 * opens its own WebSocket to /ws/terminal (tickets come from the window over
 * the bridge), so output goes straight from the backend into xterm: no JSON
 * round trip through the app's main socket, no postMessage hop.
 *
 * What makes it feel native:
 *   - WebGL renderer (DOM fallback on context loss), Unicode 11 widths, fit,
 *     web links + OSC 8 hyperlinks, true colour, mouse, bracketed paste.
 *   - OSC 52 → the browser clipboard (copy from vim/tmux/Claude Code).
 *   - Shift/Ctrl+Enter as CSI-u (newline in coding agents), optional Option-as-Meta,
 *     Cmd (macOS) / Ctrl+Shift shortcuts: copy, paste, clear, font size.
 *   - Reconnect with backoff, and at once when the tab/app comes back.
 *   - The pane has one size (shared by everyone watching): when it is larger
 *     than this view, the screen is scaled down instead of garbled.
 *   - Report suppression: in a tmux-backed session tmux is the terminal the
 *     app talks to and answers its queries (DA, DSR/CPR, DECRQM…); xterm's own
 *     answers would arrive as stray input, so they are dropped.
 *
 * Bridge protocol: see protocol.ts (ParentMessage / PageMessage).
 */

import { FitAddon } from "@xterm/addon-fit"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { WebglAddon } from "@xterm/addon-webgl"
import { type ITheme, Terminal } from "@xterm/xterm"
import { TerminalConnection } from "./connection"
import { applyModifiers, csiUFor, isMac, localShortcut, osc52Text } from "./keys"
import {
  DEFAULT_LABELS,
  isAsleep,
  isViewOnly,
  KIND_SNAPSHOT,
  type PageMessage,
  type PaneLabels,
  type ParentMessage,
  paneStateForError,
  parseMessage,
  type ThemeMode,
} from "./protocol"

const THEMES: Record<ThemeMode, ITheme> = {
  dark: {
    // The crew design's canvas: the rail's selected slot melts into it.
    background: "#0e0c12",
    foreground: "#ece7f3",
    cursor: "#ee9472",
    cursorAccent: "#0e0c12",
    selectionBackground: "#3e4a61",
    black: "#3f4451",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#d7dae0",
    brightBlack: "#5c6370",
    brightRed: "#ff7a85",
    brightGreen: "#b5e890",
    brightYellow: "#f0d197",
    brightBlue: "#80c4ff",
    brightMagenta: "#de9bf0",
    brightCyan: "#7fd1dc",
    brightWhite: "#ffffff",
    scrollbarSliderBackground: "rgba(212,216,223,0.14)",
    scrollbarSliderHoverBackground: "rgba(212,216,223,0.3)",
    scrollbarSliderActiveBackground: "rgba(212,216,223,0.4)",
  },
  light: {
    // The crew design's light canvas (design system main100) and ink (main800):
    // the pane melts into the rail's selected slot like the dark one does.
    background: "#faf9fc",
    foreground: "#342f3d",
    cursor: "#6f27ff",
    cursorAccent: "#faf9fc",
    selectionBackground: "#e7dcff",
    black: "#2b2f36",
    red: "#c8414b",
    green: "#3f8a2f",
    yellow: "#9a6b00",
    blue: "#2f68c8",
    magenta: "#9c3fb5",
    cyan: "#1f7f8c",
    white: "#c4c7cc",
    brightBlack: "#6b7280",
    brightRed: "#e0535d",
    brightGreen: "#4fa33c",
    brightYellow: "#b88200",
    brightBlue: "#4a82e0",
    brightMagenta: "#b65ad0",
    brightCyan: "#2a97a6",
    brightWhite: "#f3f4f6",
    scrollbarSliderBackground: "rgba(43,47,54,0.12)",
    scrollbarSliderHoverBackground: "rgba(43,47,54,0.26)",
    scrollbarSliderActiveBackground: "rgba(43,47,54,0.36)",
  },
}

const DEFAULT_FONT_SIZE = 13
const MIN_FONT = 9
const MAX_FONT = 24
const STATS_MS = 5000

const mac = isMac()

function storedFontSize(): number {
  try {
    const n = Number(localStorage.getItem("teros.terminal.fontSize"))
    return n >= MIN_FONT && n <= MAX_FONT ? n : DEFAULT_FONT_SIZE
  } catch {
    return DEFAULT_FONT_SIZE
  }
}

function storeFontSize(n: number): void {
  try {
    localStorage.setItem("teros.terminal.fontSize", String(n))
  } catch {
    /* storage unavailable: the size just isn't remembered */
  }
}

function toParent(message: PageMessage): void {
  const data = JSON.stringify(message)
  const native = (window as { ReactNativeWebView?: { postMessage(d: string): void } })
    .ReactNativeWebView
  if (native) native.postMessage(data)
  // srcdoc iframe: same origin as the window that embeds it.
  else window.parent.postMessage(data, window.origin === "null" ? "*" : window.origin)
}

function openLink(uri: string): void {
  try {
    const url = new URL(uri)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    window.open(url.toString(), "_blank", "noopener,noreferrer")
  } catch {
    /* not a URL */
  }
}

// ── Terminal ──────────────────────────────────────────────────────────────────

const hostEl = document.getElementById("terminal") as HTMLElement
let theme: ThemeMode = "dark"

const terminal = new Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  fontSize: storedFontSize(),
  fontFamily:
    '"JetBrains Mono", "SF Mono", Menlo, Monaco, "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
  lineHeight: 1.1,
  scrollback: 5000,
  macOptionIsMeta: false,
  macOptionClickForcesSelection: true,
  drawBoldTextInBrightColors: true,
  theme: THEMES.dark,
  linkHandler: { activate: (_event, uri) => openLink(uri), allowNonHttpProtocols: false },
})
const fit = new FitAddon()
terminal.loadAddon(fit)
terminal.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)))
terminal.loadAddon(new Unicode11Addon())
terminal.unicode.activeVersion = "11"
terminal.open(hostEl)

// WebGL on desktop. Touch devices keep the DOM renderer: on high pixel
// ratios (3x phones) the WebGL addon backed its canvas at 2x while drawing 3x
// glyphs (text overflowed the grid), and mobile browsers cap WebGL contexts.
const touchDevice = window.matchMedia?.("(pointer: coarse)").matches === true
if (!touchDevice) {
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    terminal.loadAddon(webgl)
  } catch {
    // No WebGL (old device, blocked GPU): the DOM renderer stays.
  }
}

function applyTheme(mode: ThemeMode): void {
  theme = mode
  terminal.options.theme = THEMES[mode]
  document.documentElement.style.background = THEMES[mode].background ?? ""
  document.body.style.background = THEMES[mode].background ?? ""
  document.documentElement.classList.toggle("light", mode === "light")
}
applyTheme(new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark")

// ── Report suppression (tmux answers the app's queries) ──────────────────────

let suppressReports = true
const swallow = () => suppressReports
terminal.parser.registerCsiHandler({ final: "c" }, swallow) // DA1
terminal.parser.registerCsiHandler({ prefix: ">", final: "c" }, swallow) // DA2
terminal.parser.registerCsiHandler({ prefix: "=", final: "c" }, swallow) // DA3
terminal.parser.registerCsiHandler({ final: "n" }, swallow) // DSR / CPR
terminal.parser.registerCsiHandler({ prefix: "?", final: "n" }, swallow)
terminal.parser.registerCsiHandler({ intermediates: "$", final: "p" }, swallow) // DECRQM
terminal.parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, swallow)
terminal.parser.registerCsiHandler({ prefix: ">", final: "q" }, swallow) // XTVERSION
terminal.parser.registerDcsHandler({ intermediates: "$", final: "q" }, swallow) // DECRQSS
terminal.parser.registerDcsHandler({ intermediates: "+", final: "q" }, swallow) // XTGETTCAP
for (const osc of [4, 10, 11, 12]) {
  terminal.parser.registerOscHandler(osc, (data) => suppressReports && data.includes("?"))
}

// OSC 52: copy to the browser clipboard (queries are never answered).
terminal.parser.registerOscHandler(52, (data) => {
  const text = osc52Text(data)
  if (text !== null) void navigator.clipboard?.writeText(text).catch(() => {})
  return true
})

// ── Connection ────────────────────────────────────────────────────────────────

let terminalId = ""
let ended = false
/** Foreground program of the attached session (from the server's session state). */
let foreground = ""
/** Who holds the wheel of the attached session: the pane is read-only while
 *  someone else drives (an agent, or another person) — keys are not sent, the
 *  chip says who drives and offers the wheel. Null until the server says. */
let driver: { kind: "agent" | "human" | "none"; id?: string; name?: string } | null = null
let watchOnly = false
const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash"])
let pane = { cols: terminal.cols, rows: terminal.rows }

const conn = new TerminalConnection({
  frame: (frame) => {
    if (frame.id !== terminalId) return
    const bytes = frame.payload.length
    if (frame.kind === KIND_SNAPSHOT) {
      terminal.reset()
      terminal.clear()
    }
    terminal.write(frame.payload, () => conn.rendered(bytes))
  },
  text: (msg) => onServerMessage(msg),
  status: (status) => {
    toParent({ type: "status", conn: status })
    if (status === "offline") showState("reconnecting")
  },
  needTicket: () => toParent({ type: "need_ticket" }),
})

function onServerMessage(msg: Record<string, unknown>): void {
  if (msg.id !== undefined && msg.id !== terminalId) return
  switch (msg.t) {
    case "attached": {
      notFound = null
      showState(null)
      const session = (msg.session ?? null) as {
        persistent?: boolean
        command?: string | null
        driver?: { kind: "agent" | "human" | "none"; id?: string; name?: string } | null
      } | null
      foreground = session?.command ?? ""
      driver = session?.driver ?? { kind: "none" }
      watchOnly = msg.viewOnly === true
      if (watchOnly) terminal.blur()
      updateReadOnly()
      // Legacy PTY sessions have no tmux in between: xterm is the terminal.
      suppressReports = session?.persistent !== false
      // Status is per attached session: switching tabs reuses a live socket.
      toParent({ type: "status", conn: "live" })
      toParent({
        type: "state",
        session: msg.session as never,
        typing: (msg.typing ?? null) as never,
        watchers: (msg.watchers ?? []) as string[],
      })
      return
    }
    case "size":
      applyPaneSize(Number(msg.cols), Number(msg.rows))
      return
    case "state": {
      const session = msg.session as
        | {
            command?: string | null
            driver?: { kind: "agent" | "human" | "none"; id?: string; name?: string } | null
          }
        | null
        | undefined
      foreground = session?.command ?? foreground
      if (session && session.driver !== undefined) {
        driver = session.driver
        updateReadOnly()
      }
      toParent({
        type: "state",
        session: msg.session as never,
        typing: (msg.typing ?? null) as never,
        watchers: (msg.watchers ?? []) as string[],
      })
      return
    }
    case "exit":
      ended = true
      terminal.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n")
      conn.end()
      toParent({
        type: "exit",
        code: Number(msg.code ?? 0),
        reason: msg.reason as string | undefined,
      })
      toParent({ type: "status", conn: "ended" })
      showState("ended")
      return
    case "err": {
      const code = String(msg.code ?? "")
      // A session being created right now (the window shows its tab at once):
      // not there yet, so try again for a while instead of reporting "No access".
      if (code === "TERMINAL_NOT_FOUND" && notFoundSince(terminalId) < NOT_FOUND_RETRY_MS) {
        toParent({ type: "status", conn: "connecting", detail: code })
        showState("starting")
        const id = terminalId
        setTimeout(() => {
          if (terminalId === id && !ended) conn.reattach()
        }, 700)
        return
      }
      if (code === "TERMINAL_NOT_FOUND") {
        ended = true
        toParent({ type: "status", conn: "ended", detail: code })
        showState("ended")
        return
      }
      // The wheel is someone else's (the server refused the keys): the chip
      // says who drives and offers the way out. Not an error state — the
      // session is live, we are just not driving it.
      if (code === "WHEEL_HELD") {
        showReadOnly()
        return
      }
      if (isViewOnly(code)) {
        watchOnly = true
        updateReadOnly()
        return
      }
      if (isAsleep(code)) {
        toParent({ type: "status", conn: "failed", detail: code })
        showState("asleep")
        return
      }
      const state = paneStateForError(code)
      toParent({ type: "status", conn: state, detail: code })
      showState(state)
      return
    }
    default:
      return
  }
}

// The pane is read-only while someone else drives: a quiet chip says who has
// the wheel, with the way out (the window's take-the-wheel button).
function updateReadOnly(): void {
  const el = stateEl
  if (!el) return
  if (watchOnly) {
    renderState("read-only" as PaneState)
    return
  }
  const d = driver
  if (!d || d.kind === "none" || d.kind === "human") {
    if (shownState === "read-only" as PaneState) renderState(null)
    return
  }
  if (shownState === "read-only" as PaneState) {
    // Already up: refresh the text in case the driver changed.
    renderState("read-only" as PaneState)
  }
}

function showReadOnly(): void {
  if (driver || watchOnly) renderState("read-only" as PaneState)
}

function mayNotType(): boolean {
  return watchOnly || (!!driver && driver.kind !== "none" && driver.kind !== "human")
}

/** How long a session may be missing before the pane gives up (a cold create takes a while). */
const NOT_FOUND_RETRY_MS = 120_000
let notFound: { id: string; since: number } | null = null
function notFoundSince(id: string): number {
  if (notFound?.id !== id) notFound = { id, since: Date.now() }
  return Date.now() - notFound.since
}

// ── Size: the pane's size is the server's; this view fits or scales ─────────

function fittedSize(): { cols: number; rows: number } | null {
  const d = fit.proposeDimensions()
  if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows) || d.cols <= 0) return null
  return { cols: Math.max(10, d.cols), rows: Math.max(3, d.rows) }
}

function applyPaneSize(cols: number, rows: number): void {
  if (!(cols > 0 && rows > 0)) return
  pane = { cols, rows }
  if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows)
  layoutScale()
  requestAnimationFrame(layoutScale)
}

/** Scale the screen down when the shared pane is bigger than this view. */
function layoutScale(): void {
  const el = terminal.element
  if (!el) return
  el.style.transform = ""
  const sw = el.scrollWidth
  const sh = el.scrollHeight
  const hw = hostEl.clientWidth
  const hh = hostEl.clientHeight
  if (!sw || !sh || !hw || !hh) return
  const scale = Math.min(1, hw / sw, hh / sh)
  el.style.transformOrigin = "top left"
  el.style.transform = scale < 0.999 ? `scale(${scale})` : ""
}

let resizeTimer: ReturnType<typeof setTimeout> | null = null
new ResizeObserver(() => {
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    const size = fittedSize()
    if (size) conn.resize(size.cols, size.rows)
    layoutScale()
  }, 40)
}).observe(hostEl)

// Introspection for tests and support: what this view fits vs. the shared pane size.
;(window as { __terosTerminalDebug?: () => object }).__terosTerminalDebug = () => ({
  terminalId,
  fitted: fittedSize(),
  pane,
  xterm: { cols: terminal.cols, rows: terminal.rows },
  host: { w: hostEl.clientWidth, h: hostEl.clientHeight },
})

// ── Input ─────────────────────────────────────────────────────────────────────

let modifiers = { ctrl: false, alt: false }

terminal.onData((data) => {
  if (ended) return
  // Read-only while someone else drives: the keys never leave the page (the
  // server refuses them too — this keeps the pane quiet and the chip up).
  if (mayNotType()) {
    showReadOnly()
    return
  }
  let out = data
  if (modifiers.ctrl || modifiers.alt) {
    out = applyModifiers(data, modifiers)
    modifiers = { ctrl: false, alt: false }
    toParent({ type: "modifier_reset" })
  }
  conn.input(out)
})
terminal.onBinary((data) => {
  if (ended) return
  if (mayNotType()) {
    showReadOnly()
    return
  }
  conn.input(data)
})

function setFontSize(n: number): void {
  const size = Math.min(MAX_FONT, Math.max(MIN_FONT, n))
  terminal.options.fontSize = size
  storeFontSize(size)
  const fitted = fittedSize()
  if (fitted) conn.resize(fitted.cols, fitted.rows)
  layoutScale()
}

terminal.attachCustomKeyEventHandler((event) => {
  const action = localShortcut(event, mac)
  if (action) {
    switch (action) {
      case "copy": {
        const text = terminal.getSelection()
        if (!text) return mac ? false : true
        event.preventDefault()
        void navigator.clipboard?.writeText(text).catch(() => {})
        return false
      }
      case "paste":
        // Let the browser fire its paste event: xterm wraps it in bracketed paste.
        return false
      case "clear":
        event.preventDefault()
        terminal.clear()
        return false
      case "select-all":
        event.preventDefault()
        terminal.selectAll()
        return false
      case "font+":
        event.preventDefault()
        setFontSize((terminal.options.fontSize ?? DEFAULT_FONT_SIZE) + 1)
        return false
      case "font-":
        event.preventDefault()
        setFontSize((terminal.options.fontSize ?? DEFAULT_FONT_SIZE) - 1)
        return false
      case "font0":
        event.preventDefault()
        setFontSize(DEFAULT_FONT_SIZE)
        return false
      case "prev-session":
      case "next-session":
      case "take-wheel":
      case "go-session":
      case "float":
      case "rail-left":
      case "rail-right":
        event.preventDefault()
        toParent({ type: "shortcut", action })
        return false
    }
  }
  // CSI-u Shift/Ctrl+Enter is for TUIs (coding agents' "newline"); readline
  // doesn't know it and would print ";2u", so in a plain shell it stays Enter.
  const seq = SHELLS.has(foreground) ? null : csiUFor(event)
  if (seq) {
    if (event.type === "keydown" && !ended) {
      event.preventDefault()
      conn.input(seq)
    }
    return false
  }
  return true
})

terminal.onTitleChange((title) => toParent({ type: "title", title }))
terminal.onBell(() => toParent({ type: "bell" }))
terminal.textarea?.addEventListener("focus", () => toParent({ type: "focused" }))
// IME composition: let xterm put its textarea at the cursor (see build.ts CSS).
terminal.textarea?.addEventListener("compositionstart", () =>
  terminal.element?.classList.add("composing"),
)
terminal.textarea?.addEventListener("compositionend", () =>
  terminal.element?.classList.remove("composing"),
)

// ── Bridge: window → page ────────────────────────────────────────────────────

function receive(raw: unknown): void {
  const msg = parseMessage<ParentMessage>(raw)
  if (!msg) return
  switch (msg.type) {
    case "init": {
      setLabels(msg.labels)
      if (msg.theme) applyTheme(msg.theme)
      if (msg.fontSize) setFontSize(msg.fontSize)
      terminal.options.macOptionIsMeta = msg.optionIsMeta === true
      conn.configure(msg.wsUrl)
      attachTo(msg.terminalId, msg.focus !== false)
      toParent({ type: "need_ticket" })
      return
    }
    case "ticket":
      conn.open(msg.ticket)
      return
    case "attach":
      attachTo(msg.terminalId, msg.focus !== false)
      return
    case "input":
      if (msg.data) terminal.input(msg.data, true)
      terminal.focus()
      return
    case "set_modifier":
      modifiers = { ...modifiers, [msg.modifier]: msg.active }
      terminal.focus()
      return
    case "options":
      setLabels(msg.labels)
      if (msg.theme) applyTheme(msg.theme)
      if (msg.fontSize) setFontSize(msg.fontSize)
      if (msg.optionIsMeta !== undefined) terminal.options.macOptionIsMeta = msg.optionIsMeta
      return
    case "focus":
      terminal.focus()
      return
    case "clear":
      terminal.clear()
      return
  }
}

function attachTo(id: string, focus: boolean): void {
  if (!id || id === terminalId) return
  terminalId = id
  ended = false
  driver = null
  watchOnly = false
  terminal.reset()
  const size = fittedSize() ?? pane
  conn.attach(id, size.cols, size.rows)
  // Focus only when the window says so AND nobody else drives: an
  // auto-focused pane is how a mere viewer used to steal the wheel (xterm's
  // focus reports arrived as keystrokes). While an agent drives, the pane
  // stays unfocused — clicking it shows the read-only chip, not a cursor.
  if (focus && (!driver || driver.kind === "none" || driver.kind === "human")) terminal.focus()
  updateJump()
  showState("starting")
}

// ── Pane states (drawn by the page: they work the same in the iframe and the WebView) ──

type PaneState =
  | "starting"
  | "reconnecting"
  | "ended"
  | "denied"
  | "failed"
  | "read-only"
  | "asleep"
let labels: PaneLabels = DEFAULT_LABELS
const stateEl = document.getElementById("state") as HTMLElement | null
let stateTimer: ReturnType<typeof setTimeout> | null = null
let shownState: PaneState | null = null

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button")
  b.type = "button"
  b.textContent = text
  b.addEventListener("click", onClick)
  return b
}

function renderState(state: PaneState | null): void {
  shownState = state
  if (!stateEl) return
  stateEl.replaceChildren()
  stateEl.className = state ? `show ${state}` : ""
  if (!state) return
  const text = document.createElement("span")
  if (state === "read-only" && watchOnly) {
    text.textContent = labels.watchOnly
    stateEl.append(text)
    return
  }
  if (state === "asleep") {
    text.textContent = labels.asleep
    stateEl.append(text)
    stateEl.append(button(labels.retry, () => conn.reattach()))
    return
  }
  if (state === "read-only") {
    const d = driver
    const name = d?.kind === "agent" ? d.name || "The agent" : d?.name || "Someone"
    text.textContent = labels.readOnly.replace("{{name}}", name)
    stateEl.append(text)
    stateEl.append(
      button(labels.takeWheel, () => toParent({ type: "shortcut", action: "take-wheel" })),
    )
    return
  }
  text.textContent =
    state === "starting"
      ? labels.starting
      : state === "reconnecting"
        ? labels.reconnecting
        : state === "ended"
          ? labels.ended
          : state === "failed"
            ? labels.failed
            : labels.denied
  stateEl.append(text)
  if (state === "reconnecting") stateEl.append(button(labels.retry, () => conn.wake()))
  if (state === "failed") stateEl.append(button(labels.retry, () => conn.reattach()))
  if (state === "ended") {
    stateEl.append(button(labels.restart, () => toParent({ type: "action", action: "restart" })))
    stateEl.append(button(labels.close, () => toParent({ type: "action", action: "close" })))
  }
  if (state === "denied")
    stateEl.append(button(labels.close, () => toParent({ type: "action", action: "close" })))
}

/** Show a pane state; "starting" only if it lasts (no flash on a quick attach). */
function showState(state: PaneState | null): void {
  if (stateTimer) clearTimeout(stateTimer)
  stateTimer = null
  if (state === "starting") {
    if (shownState === "starting") return
    stateTimer = setTimeout(() => renderState("starting"), 600)
    return
  }
  if (state === null && shownState === ("read-only" as PaneState)) return
  renderState(state)
}

function setLabels(next: Partial<PaneLabels> | undefined): void {
  if (!next) return
  labels = { ...labels, ...next }
  if (jumpEl) {
    jumpEl.title = labels.jump
    jumpEl.setAttribute("aria-label", labels.jump)
  }
  if (shownState) renderState(shownState)
}

/**
 * A read-only pane (someone else at the wheel) keeps its chip while the
 * session streams: output arrives, states come and go — the chip stays until
 * the wheel changes hands.
 */
// ── Jump to the bottom (scrolled up while output keeps coming) ───────────────

const jumpEl = document.getElementById("jump") as HTMLButtonElement | null

function updateJump(): void {
  if (!jumpEl) return
  const buf = terminal.buffer.active
  jumpEl.classList.toggle("show", buf.viewportY < buf.baseY)
}

jumpEl?.addEventListener("click", () => {
  terminal.scrollToBottom()
  terminal.focus()
  updateJump()
})
terminal.onScroll(() => updateJump())
terminal.onWriteParsed(() => updateJump())

;(window as { terosTerminal?: { receive(raw: string): void } }).terosTerminal = { receive }
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return
  receive(event.data)
})

// Back from background (phone lock, tab switch, network): reconnect at once.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) conn.wake()
})
window.addEventListener("online", () => conn.wake())
window.addEventListener("pageshow", () => conn.wake())

// Latency + throughput for the window (and for measurements).
let lastStats = ""
setInterval(() => {
  const echo = conn.echoStats()
  const stats = {
    type: "stats" as const,
    rttMs: conn.rttMs,
    echoP50: echo.p50,
    echoP95: echo.p95,
    bytesIn: conn.bytesIn,
    resyncs: 0,
  }
  ;(window as { __terosTerminalStats?: object }).__terosTerminalStats = stats
  const key = JSON.stringify(stats)
  if (key !== lastStats) {
    lastStats = key
    toParent(stats)
  }
}, STATS_MS)

void theme
toParent({ type: "ready" })
