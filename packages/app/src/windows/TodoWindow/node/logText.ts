/**
 * The backend writes log entries in English ("working → blocked: reason",
 * "Progress 40%", "Planned for 2026-10-24" …). This maps them to the
 * window's language and recognises state transitions so the log can draw
 * them with dots.
 */
import { STATE_ORDER } from "../model/states"
import type { LogEntry, NodeState } from "../model/types"

export type LogLine =
  | { kind: "transition"; from: NodeState; to: NodeState; note: string | null }
  | { kind: "text"; text: string }

const STATE_RE = STATE_ORDER.join("|")
const TRANSITION = new RegExp(`^(${STATE_RE}) → (${STATE_RE})(?::\\s*(.*))?$`)

export function readLog(
  entry: LogEntry,
  t: (k: string, o?: Record<string, unknown>) => string,
  dayLabel: (iso: string) => string,
): LogLine {
  const s = entry.text
  let m: RegExpExecArray | null
  if ((m = TRANSITION.exec(s))) return { kind: "transition", from: m[1] as NodeState, to: m[2] as NodeState, note: m[3] ?? null }
  if ((m = /^Reply: ([\s\S]*)$/.exec(s))) return { kind: "text", text: t("todo.log.replied", { text: m[1] }) }
  if ((m = /^Progress (\d+)%$/.exec(s))) return { kind: "text", text: t("todo.log.progress", { value: m[1] }) }
  if (s === "Progress cleared") return { kind: "text", text: t("todo.log.progressCleared") }
  if ((m = /^Planned for (\d{4}-\d{2}-\d{2})(?: at (\d{2}:\d{2}))?$/.exec(s)))
    return { kind: "text", text: `${t("todo.log.plannedFor", { day: dayLabel(m[1]).toLowerCase() })}${m[2] ? ` · ${m[2]}` : ""}` }
  if ((m = /^Planned time (\d{2}:\d{2})$/.exec(s))) return { kind: "text", text: t("todo.log.plannedTime", { time: m[1] }) }
  if (s === "Planned time cleared") return { kind: "text", text: t("todo.log.plannedTimeCleared") }
  if (s === "Removed from the day") return { kind: "text", text: t("todo.log.removedFromDay") }
  if ((m = /^Output delivered · (.*)$/.exec(s))) return { kind: "text", text: t("todo.log.outputDelivered", { what: ioWord(m[1], t) }) }
  if (s === "Output cleared") return { kind: "text", text: t("todo.log.outputCleared") }
  if ((m = /^Input set · (.*)$/.exec(s))) return { kind: "text", text: t("todo.log.inputSet", { what: ioWord(m[1], t) }) }
  if (s === "Input cleared") return { kind: "text", text: t("todo.log.inputCleared") }
  if (/^Marked as completed/.test(s)) return { kind: "text", text: t("todo.log.completed") + suffix(s) }
  if (/^Marked as not completed/.test(s)) return { kind: "text", text: t("todo.log.uncompleted") + suffix(s) }
  if ((m = /^Assigned to (.*)$/.exec(s))) return { kind: "text", text: t("todo.log.assignedTo", { name: m[1] }) }
  if (s === "Unassigned") return { kind: "text", text: t("todo.log.unassigned") }
  if (s === "Converted to group") return { kind: "text", text: t("todo.log.toGroup") }
  if (s === "Converted to task") return { kind: "text", text: t("todo.log.toTask") }
  if ((m = /^Blocked: ([\s\S]*)$/.exec(s))) return { kind: "text", text: t("todo.log.blockedReason", { reason: m[1] }) }
  return { kind: "text", text: s }
}

function suffix(s: string): string {
  const m = /\(and (\d+) descendants?\)$/.exec(s)
  return m ? ` (+${m[1]})` : ""
}

function ioWord(what: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (what === "markdown") return t("todo.io.markdown")
  if (what === "form") return "form"
  const m = /^file (.*)$/.exec(what)
  return m ? m[1] : what
}

/** Timestamp of the latest entry matching `re`, if any. */
export function lastAt(log: LogEntry[], re: RegExp): number | null {
  for (let i = log.length - 1; i >= 0; i--) if (re.test(log[i].text)) return log[i].timestamp
  return null
}
