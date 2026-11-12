/**
 * What a coding agent asks on a terminal screen, for the chat's needs-you
 * card: the question, the line it is about (the command it wants to run) and
 * its numbered options. Pure — parsed from the plain-text screen that
 * mca.teros.terminal returns with a blocked terminal-wait / terminal-prompt.
 */

export interface TerminalOption {
  /** The key that picks it ("1"). */
  key: string
  /** Its text as the screen shows it. */
  label: string
  /** The option the cursor (❯) is on. */
  selected: boolean
}

export interface TerminalQuestion {
  question: string | null
  /** What it is about (the command of a permission prompt), if the screen shows it. */
  detail: string | null
  options: TerminalOption[]
}

/** Box-drawing borders and padding of a TUI dialog row. */
function clean(line: string): string {
  return line
    .replace(/^[\s│┃|╭╰╮╯┌└]+/, "")
    .replace(/[\s│┃|╭╰╮╯┐┘]+$/, "")
    .trim()
}

const OPTION = /^(❯|›|>)?\s*(\d{1,2})[.)]\s+(.+)$/
const RULE = /^[─━═-]{3,}$/

/** The question, its subject and the numbered options at the bottom of a screen. */
export function parseTerminalQuestion(
  screen: string | null | undefined,
  hint?: string | null,
): TerminalQuestion {
  const rows = (screen ?? "").split("\n").map(clean)
  // The last run of numbered rows 1..n (the menu nearest the bottom).
  let end = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (OPTION.test(rows[i])) {
      end = i
      break
    }
  }
  const options: TerminalOption[] = []
  let start = end
  if (end >= 0) {
    while (start - 1 >= 0 && (OPTION.test(rows[start - 1]) || isWrap(rows, start - 1))) start--
    for (let i = start; i <= end; i++) {
      const m = rows[i].match(OPTION)
      if (m) options.push({ key: m[2], label: m[3].trim(), selected: !!m[1] })
      else if (options.length && rows[i]) options[options.length - 1].label += ` ${rows[i]}`
    }
    // A menu is numbered from 1 without gaps; anything else is output that looks like a list.
    if (!options.every((o, i) => Number(o.key) === i + 1)) options.length = 0
  }

  let question: string | null = null
  let qi = -1
  for (let i = (options.length ? start : rows.length) - 1; i >= 0 && i >= start - 12; i--) {
    if (/\?$/.test(rows[i])) {
      question = rows[i]
      qi = i
      break
    }
  }
  if (!question && hint) question = hint.replace(/\s*\(selected:[^)]*\)\s*$/, "").trim() || null

  // The subject: the first meaningful row of the dialog above the question
  // (Claude Code: a title such as "Bash command", then the command).
  let detail: string | null = null
  if (qi > 0) {
    const block: string[] = []
    for (let i = qi - 1; i >= 0 && i >= qi - 8; i--) {
      if (!rows[i] || RULE.test(rows[i])) {
        if (block.length) break
        continue
      }
      block.unshift(rows[i])
    }
    const body = block.filter(
      (r) => !/^(bash command|edit file|create file|read file|fetch|tool use|command)$/i.test(r),
    )
    detail = body[0] ?? null
  }
  return { question, detail, options }
}

/** The wrapped tail of a long option: plain text with an option right above it. */
function isWrap(rows: string[], i: number): boolean {
  const row = rows[i]
  if (!row || OPTION.test(row) || /\?$/.test(row) || RULE.test(row)) return false
  return (
    OPTION.test(rows[i - 1] ?? "") ||
    (!!rows[i - 1] && OPTION.test(rows[i - 2] ?? "") && !/\?$/.test(rows[i - 1]))
  )
}

/** A short button label for an option ("Yes", "Always", "No…"). */
export function shortOptionLabel(
  label: string,
  t: (key: string, fallback: string) => string,
): string {
  const l = label.trim()
  if (
    /^yes,?\s+(and\s+)?(don'?t|do not) ask again/i.test(l) ||
    /^yes,?\s+allow (all|always)/i.test(l)
  )
    return t("terminal.chat.always", "Always")
  if (/^no,?\s+and\s+tell/i.test(l) || /^no\b.*\(esc\)$/i.test(l))
    return t("terminal.chat.noEllipsis", "No…")
  const plain = l.replace(/\s*\(esc\)$/i, "")
  return plain.length > 26 ? `${plain.slice(0, 25)}…` : plain
}
