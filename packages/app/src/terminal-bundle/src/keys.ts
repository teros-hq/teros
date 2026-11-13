/**
 * Keys a browser terminal can't encode on its own (salvaged from the parked
 * web-terminal work): Shift/Ctrl+Enter as CSI-u, the extra-keys bar's sticky
 * Ctrl / Alt applied to the next key, and OSC 52 clipboard payloads.
 */

export interface KeyLike {
  type: string
  key: string
  code?: string
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

/**
 * Shift/Ctrl+Enter → the sequence coding agents read as "newline, don't send"
 * (`\x1b[13;2u` = CSI-u Shift+Enter, `\x1b[13;5u` Ctrl+Enter). Null lets xterm
 * handle the key (plain Enter, Alt+Enter = ESC CR, Cmd+Enter).
 */
export function csiUFor(event: KeyLike): string | null {
  if (event.key !== "Enter" || event.metaKey) return null
  const mods = (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0)
  if (mods === 0 || mods === 2) return null
  return `\x1b[13;${1 + mods}u`
}

/** Ctrl+<char> as its control code (Ctrl+A → \x01, Ctrl+[ → ESC, Ctrl+Space → NUL). */
export function ctrlSeq(char: string): string {
  if (char === " ") return "\x00"
  const code = char.toUpperCase().charCodeAt(0)
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
  return char
}

/** Apply the bar's sticky modifiers to typed data (one-shot: the caller clears them). */
export function applyModifiers(data: string, mods: { ctrl: boolean; alt: boolean }): string {
  let out = data
  if (mods.ctrl && out.length === 1) out = ctrlSeq(out)
  if (mods.alt) out = `\x1b${out}`
  return out
}

/** OSC 52 payload (`c;<base64>`) → the text to put on the clipboard, or null (queries are refused). */
export function osc52Text(data: string): string | null {
  const b64 = data.slice(data.indexOf(";") + 1)
  if (!b64 || b64 === "?" || data.indexOf(";") === -1) return null
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** The platform's command modifier: Cmd on macOS/iOS, Ctrl+Shift elsewhere. */
export function isMac(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}

export type LocalAction =
  | "copy"
  | "paste"
  | "clear"
  | "font+"
  | "font-"
  | "font0"
  | "select-all"
  | WindowShortcut

/** Shortcuts the Terminal window handles (the page only reports them). */
export type WindowShortcut =
  | "prev-session"
  | "next-session"
  | "take-wheel"
  | "go-session"
  | "float"
  | "rail-left"
  | "rail-right"

/** Terminal-app shortcuts handled locally (never sent to the shell). */
export function localShortcut(event: KeyLike, mac: boolean): LocalAction | null {
  if (event.type !== "keydown") return null
  const cmd = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey
  if (!cmd) return null
  // Cmd+Alt+[ / ] (Ctrl+Shift+Alt+[ / ] elsewhere): the crew rail to the left / right.
  if (event.altKey && event.code === "BracketLeft") return "rail-left"
  if (event.altKey && event.code === "BracketRight") return "rail-right"
  // Cmd+Shift+K / F (Ctrl+Shift+Alt+K / F elsewhere): take the wheel / float this terminal.
  if ((mac ? event.shiftKey : event.altKey) && event.code === "KeyK") return "take-wheel"
  if ((mac ? event.shiftKey : event.altKey) && event.code === "KeyF") return "float"
  if ((mac ? event.shiftKey : event.altKey) && event.code === "KeyO") return "go-session"
  // Cmd+Shift+[ / ] (Ctrl+Shift+[ / ] elsewhere): previous / next session, like terminal apps' tabs.
  if (event.shiftKey && event.code === "BracketLeft") return "prev-session"
  if (event.shiftKey && event.code === "BracketRight") return "next-session"
  switch (event.key.toLowerCase()) {
    case "c":
      return "copy"
    case "v":
      return "paste"
    case "k":
      return "clear"
    case "a":
      return mac ? "select-all" : null
    case "=":
    case "+":
      return "font+"
    case "-":
    case "_":
      return "font-"
    case "0":
      return "font0"
    default:
      return null
  }
}
