/**
 * Screen snapshots from tmux's own grid — what a (re)attaching viewer sees and
 * what an agent reads as "the rendered screen".
 *
 * tmux keeps every pane's screen and history in the workspace's terminal host,
 * so the backend holds no emulator per session. A viewer snapshot is the pane
 * history + screen (`capture-pane -e`, SGR attributes included) followed by the
 * terminal modes tmux exposes as formats (alternate screen, cursor, keypad,
 * mouse, scroll region) and the ones it doesn't (bracketed paste, tracked by
 * the backend from the output stream into the `@teros_bp` pane option).
 * The client writes it into a freshly reset xterm and then applies live
 * output: in control mode, every `%output` before the capture reply is already
 * in it, everything after is a delta — an exact serialization point.
 */

/** Format string for `display -p` — one field per PaneModes key, title last (it may contain anything). */
export const PANE_MODES_FORMAT = [
  "#{pane_width}",
  "#{pane_height}",
  "#{alternate_on}",
  "#{cursor_x}",
  "#{cursor_y}",
  "#{cursor_flag}",
  "#{keypad_cursor_flag}",
  "#{keypad_flag}",
  "#{mouse_standard_flag}",
  "#{mouse_button_flag}",
  "#{mouse_any_flag}",
  "#{mouse_sgr_flag}",
  "#{mouse_utf8_flag}",
  "#{insert_flag}",
  "#{scroll_region_upper}",
  "#{scroll_region_lower}",
  "#{history_size}",
  "#{@teros_bp}",
  "#{pane_current_command}",
  "#{pane_title}",
].join("\u001f")

export interface PaneModes {
  cols: number
  rows: number
  alternateOn: boolean
  cursorX: number
  cursorY: number
  cursorVisible: boolean
  keypadCursor: boolean
  keypad: boolean
  mouseStandard: boolean
  mouseButton: boolean
  mouseAny: boolean
  mouseSgr: boolean
  mouseUtf8: boolean
  insert: boolean
  scrollUpper: number
  scrollLower: number
  historySize: number
  bracketedPaste: boolean
  command: string
  title: string
}

export function parsePaneModes(line: string): PaneModes {
  const f = line.split("\u001f")
  const n = (i: number) => Number.parseInt(f[i] ?? "0", 10) || 0
  const b = (i: number) => f[i] === "1"
  return {
    cols: n(0),
    rows: n(1),
    alternateOn: b(2),
    cursorX: n(3),
    cursorY: n(4),
    cursorVisible: b(5),
    keypadCursor: b(6),
    keypad: b(7),
    mouseStandard: b(8),
    mouseButton: b(9),
    mouseAny: b(10),
    mouseSgr: b(11),
    mouseUtf8: b(12),
    insert: b(13),
    scrollUpper: n(14),
    scrollLower: n(15),
    historySize: n(16),
    bracketedPaste: b(17),
    command: f[18] ?? "",
    title: f.slice(19).join("\u001f"),
  }
}

export interface SnapshotParts {
  modes: PaneModes
  /** Scrollback lines above the screen (oldest first), `capture-pane -e -N`. */
  history: string[]
  /** The visible screen, exactly `modes.rows` lines. */
  screen: string[]
  /** When the alternate screen is on: the saved main screen (`capture-pane -a`). */
  savedMain?: string[]
}

const RESET_LINE = "\u001b[0m\r\n"

/** Replace C0/C1 control characters (and DEL) with `by`. */
export function replaceControls(text: string, by: string, also = ""): string {
  let out = ""
  for (const ch of text) {
    const c = ch.charCodeAt(0)
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) || also.includes(ch) ? by : ch
  }
  return out
}

/** Strip C0/C1 controls so a pane title can't smuggle escape sequences into the snapshot. */
function safeTitle(title: string): string {
  return replaceControls(title, "")
}

/** Bytes that reproduce the pane in a freshly reset xterm of the same size. */
export function buildSnapshot(parts: SnapshotParts): string {
  const { modes } = parts
  let out = ""
  if (modes.alternateOn) {
    out += [...parts.history, ...(parts.savedMain ?? [])].join(RESET_LINE)
    out += "\u001b[0m\u001b[?1049h\u001b[H"
    out += parts.screen.join(RESET_LINE)
  } else {
    out += [...parts.history, ...parts.screen].join(RESET_LINE)
  }
  out += "\u001b[0m"
  // Scroll region first: DECSTBM homes the cursor.
  const fullRegion =
    modes.scrollUpper === 0 && (modes.scrollLower === modes.rows - 1 || modes.scrollLower === 0)
  if (!fullRegion) out += `\u001b[${modes.scrollUpper + 1};${modes.scrollLower + 1}r`
  out += `\u001b[${modes.cursorY + 1};${modes.cursorX + 1}H`
  if (!modes.cursorVisible) out += "\u001b[?25l"
  if (modes.keypadCursor) out += "\u001b[?1h"
  if (modes.keypad) out += "\u001b="
  if (modes.insert) out += "\u001b[4h"
  if (modes.mouseStandard) out += "\u001b[?1000h"
  if (modes.mouseButton) out += "\u001b[?1002h"
  if (modes.mouseAny) out += "\u001b[?1003h"
  if (modes.mouseSgr) out += "\u001b[?1006h"
  if (modes.mouseUtf8) out += "\u001b[?1005h"
  if (modes.bracketedPaste) out += "\u001b[?2004h"
  const title = safeTitle(modes.title)
  if (title) out += `\u001b]2;${title}\u0007`
  return out
}

/** What an agent gets from a rendered read: rows as the user sees them. */
export interface RenderedScreen {
  cols: number
  rows: number
  /** Visible rows, trailing spaces trimmed; trailing empty rows kept so indices match the cursor. */
  lines: string[]
  cursor: { x: number; y: number; visible: boolean }
  title: string
  /** Foreground command in the pane (e.g. bash, claude, vim). */
  command: string
  alternateScreen: boolean
}

export function renderedScreen(modes: PaneModes, plainScreen: string[]): RenderedScreen {
  return {
    cols: modes.cols,
    rows: modes.rows,
    lines: plainScreen.map((l) => l.replace(/\s+$/, "")),
    cursor: { x: modes.cursorX, y: modes.cursorY, visible: modes.cursorVisible },
    title: safeTitle(modes.title),
    command: modes.command,
    alternateScreen: modes.alternateOn,
  }
}

/**
 * Tracks DECSET 2004 (bracketed paste) in a pane's output: tmux has no format
 * for it. Returns the new state when this chunk changes it, otherwise null.
 */
export function bracketedPasteChange(chunk: string, current: boolean): boolean | null {
  const on = chunk.lastIndexOf("\u001b[?2004h")
  const off = chunk.lastIndexOf("\u001b[?2004l")
  if (on === -1 && off === -1) return null
  const next = on > off
  return next === current ? null : next
}
