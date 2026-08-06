/**
 * Teros Terminal Bundle — xterm.js PTY bridge
 *
 * Connects xterm.js to a real PTY running on the backend via postMessage.
 * All input/output goes through the PTY — no local line editing.
 *
 * Bridge protocol:
 *   RN → xterm:  { type: 'output', data }      — raw PTY output to write
 *                { type: 'clear' }              — clear screen
 *
 *   xterm → RN:  { type: 'ready', cols, rows }  — xterm initialized
 *                { type: 'input', data }         — keystroke(s) to send to PTY
 *                { type: 'resize', cols, rows }  — terminal resized
 */

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

// ── Terminal instance ──────────────────────────────────────────────────────────

const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 13,
  fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
  theme: {
    background:          '#282c34',
    foreground:          '#abb2bf',
    cursor:              '#528bff',
    cursorAccent:        '#282c34',
    selectionBackground: '#3e4451',
    black:         '#3f4451', brightBlack:   '#4f5666',
    red:           '#e06c75', brightRed:     '#ff616e',
    green:         '#98c379', brightGreen:   '#a5e075',
    yellow:        '#e5c07b', brightYellow:  '#f0a45d',
    blue:          '#61afef', brightBlue:    '#4dc4ff',
    magenta:       '#c678dd', brightMagenta: '#de73ff',
    cyan:          '#56b6c2', brightCyan:    '#4cd1e0',
    white:         '#e6efff', brightWhite:   '#ffffff',
  },
  allowProposedApi: true,
  scrollback: 5000,
})

const fitAddon = new FitAddon()
terminal.loadAddon(fitAddon)
terminal.loadAddon(new WebLinksAddon())
terminal.open(document.getElementById('terminal')!)
fitAddon.fit()

// ── Helpers ────────────────────────────────────────────────────────────────────

function sendToRN(msg: object): void {
  const data = JSON.stringify(msg)
  if ((window as any).ReactNativeWebView) {
    ;(window as any).ReactNativeWebView.postMessage(data)
  } else {
    window.parent.postMessage(data, '*')
  }
}

// ── Forward all keystrokes directly to PTY ────────────────────────────────────

terminal.onData((data: string) => {
  sendToRN({ type: 'input', data })
})

// ── API exposed to RN component ───────────────────────────────────────────────

;(window as any).terosTerminal = {
  receive(rawMsg: string): void {
    let msg: any
    try {
      msg = JSON.parse(rawMsg)
    } catch {
      return
    }

    switch (msg.type) {
      case 'output':
        terminal.write(msg.data ?? '')
        break

      case 'clear':
        terminal.clear()
        break
    }
  },
}

// ── Listen for postMessage from parent (web iframe) ───────────────────────────

window.addEventListener('message', (e: MessageEvent) => {
  try {
    const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
    // Parent can request current size (used to recover from race condition on mount)
    if (data?.type === 'get-size') {
      sendToRN({ type: 'ready', cols: terminal.cols, rows: terminal.rows })
      return
    }
    const raw = typeof e.data === 'string' ? e.data : JSON.stringify(e.data)
    ;(window as any).terosTerminal?.receive(raw)
  } catch {
    const raw = typeof e.data === 'string' ? e.data : JSON.stringify(e.data)
    ;(window as any).terosTerminal?.receive(raw)
  }
})

// ── Resize observer ────────────────────────────────────────────────────────────

const resizeObserver = new ResizeObserver(() => {
  try {
    fitAddon.fit()
    sendToRN({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
  } catch {
    // fitAddon may throw if terminal not yet initialized
  }
})
const terminalEl = document.getElementById('terminal')
if (terminalEl) resizeObserver.observe(terminalEl)

// ── Signal ready with initial size ────────────────────────────────────────────
// Use a small delay so the parent frame has time to register its message listener
// before we send 'ready'. Without this, there's a race condition where the iframe
// script runs synchronously before the parent's useEffect has fired.

function signalReady(): void {
  sendToRN({ type: 'ready', cols: terminal.cols, rows: terminal.rows })
}

// Try immediately (for cases where parent listener is already set up)
// and again after a tick (to handle the common race condition)
signalReady()
setTimeout(signalReady, 50)
setTimeout(signalReady, 200)
