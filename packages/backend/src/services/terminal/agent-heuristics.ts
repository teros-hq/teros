/**
 * Coding-agent state from the screen, for agents without hooks (opencode,
 * aider, Codex, Gemini CLI… and Claude Code before its hooks are installed).
 * Hooks (agent-hooks.ts) are authoritative; this is the fallback.
 *
 * Only sessions whose foreground command is a known coding agent are looked
 * at, and only when they produced output since the last look, so idle
 * sessions cost nothing.
 *
 *   blocked  — a permission/confirmation prompt is on screen
 *   working  — the agent drew something in the last few seconds (not just
 *              the echo of what the person typed)
 *   done     — it was working or blocked and went quiet: its turn is over
 */

/** Foreground commands treated as coding agents. */
export const AGENT_COMMANDS = new Set([
  "claude",
  "opencode",
  "aider",
  "codex",
  "gemini",
  "goose",
  "crush",
  "amp",
  "cursor-agent",
  "qwen",
  "droid",
  "kimi",
])

/** Prompts that mean "the agent waits for the person" (bottom of the screen). */
const BLOCKED_PATTERNS: RegExp[] = [
  /permission required/i, // opencode
  /\ballow once\b/i, // opencode
  /do you want to (proceed|make this edit|create|run|allow|use this api key)/i, // Claude Code
  /yes, i trust this folder/i, // Claude Code's folder trust check
  /❯\s*1\.\s*yes\b/i, // Claude Code menu
  /\(y\)es\/\(n\)o/i, // aider
  /\[y\/n\]|\(y\/n\)|\[y\/N\]|\[Y\/n\]/, // generic confirmations
  /\ballow (this )?command\b|\bapprove\b.*\?/i, // Codex & co
]

/** Box-drawing and decoration characters TUIs frame their prompts with. */
const DECORATION = /[┃│║╹╻▀▄█▌▐─━═╭╮╰╯┌┐└┘△▲▣◆●○■□←→↑↓]/g

function cleanLine(line: string): string {
  return line.replace(DECORATION, " ").replace(/\s+/g, " ").trim()
}

/** How many bottom rows are searched for a prompt. */
const BOTTOM_ROWS = 18

/**
 * A blocking prompt on screen → a short description of it (the matched row
 * and the next meaningful one, e.g. "Permission required · Edit hello.py"),
 * otherwise null.
 */
export function detectBlocked(lines: string[]): string | null {
  const rows = lines.slice(-BOTTOM_ROWS).map(cleanLine)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row || !BLOCKED_PATTERNS.some((p) => p.test(row))) continue
    const next = rows
      .slice(i + 1)
      .find((r) => r.length > 2 && !BLOCKED_PATTERNS.some((p) => p.test(r)))
    const message = next && next.length < 80 ? `${row} · ${next}` : row
    return message.slice(0, 160)
  }
  return null
}

const RULE = /─{3,}|━{3,}/

/**
 * A selection menu waiting for the person: the last "❯" row on screen is an
 * option, not the input box (which sits right under a horizontal rule), with
 * another option next to it. Claude Code's dialogs ("Make auto mode your
 * default permission mode?", the theme picker, trust checks) look like this,
 * and they fire no hook of their own. Returns "question (selected: option)".
 */
export function detectMenu(lines: string[]): string | null {
  const rows = lines.slice(-BOTTOM_ROWS)
  let i = -1
  for (let k = rows.length - 1; k >= 0; k--) {
    if (/^\s*❯/.test(rows[k])) {
      i = k
      break
    }
  }
  if (i === -1) return null
  const option = rows[i].replace(/^\s*❯\s*/, "").trim()
  if (!option) return null
  // The input box: a rule right above the prompt row.
  if (RULE.test(rows[i - 1] ?? "")) return null
  const isOption = (r: string | undefined) =>
    r !== undefined && /^\s{2,}\S/.test(r) && !RULE.test(r)
  if (!isOption(rows[i + 1]) && !isOption(rows[i - 1])) return null
  const question = rows
    .slice(0, i)
    .reverse()
    .map(cleanLine)
    .find((r) => /\?$/.test(r))
  const selected = `(selected: ${cleanLine(option)})`
  return (question ? `${question} ${selected}` : selected).slice(0, 160)
}

/** Claude Code waiting for credentials (login method picker, "Not logged in", bad key). */
const LOGIN_PATTERNS: RegExp[] = [
  /select login method/i,
  /claude account with subscription/i,
  /not logged in\s*·?\s*run \/login/i,
  /invalid api key/i,
  /please run \/login/i,
]

export function detectLoginScreen(lines: string[]): boolean {
  return lines.some((l) => LOGIN_PATTERNS.some((p) => p.test(l)))
}

/** Output this recent means the agent is working. */
export const WORKING_WINDOW_MS = 3000
/** Output this soon after a person's keystroke is their own echo, not the agent working. */
export const ECHO_WINDOW_MS = 1500

export type HeuristicState = "working" | "blocked" | "done" | "idle"

/** Next state from what is on screen and when output last came. */
export function nextHeuristicState(input: {
  now: number
  lastOutputAt: number
  lastHumanInputAt: number | null
  previous: HeuristicState | null
  blocked: string | null
}): HeuristicState {
  if (input.blocked) return "blocked"
  const recent = input.now - input.lastOutputAt < WORKING_WINDOW_MS
  const echo =
    input.lastHumanInputAt !== null &&
    input.lastOutputAt >= input.lastHumanInputAt &&
    input.lastOutputAt - input.lastHumanInputAt < ECHO_WINDOW_MS
  // The person answered a prompt: the agent resumes.
  if (input.previous === "blocked") return recent ? "working" : "done"
  // Their own typing in the agent's input box changes nothing.
  if (echo && recent) return input.previous ?? "idle"
  if (recent) return "working"
  if (input.previous === "working") return "done"
  return input.previous ?? "idle"
}
