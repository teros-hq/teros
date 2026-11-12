/**
 * Instructions are markdown with task-list checkboxes; a heading named
 * "Done when" (or its translations) opens the final "Done when" section.
 *
 * Checkbox indices MUST match the backend's toggle-instruction-item: every
 * `- [ ]` / `* [x]` / `1. [ ]` line counted top to bottom, ignoring fenced
 * code blocks (packages/backend/src/mca-actions/todo.ts, CHECKBOX_LINE).
 */

const CHECKBOX_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s?(.*)$/
const FENCE_LINE = /^\s*(`{3,}|~{3,})/
const HEADING = /^\s*#{1,6}\s+(.*)$/
const DONE_WHEN = /^(done when|definition of done|hecho cuando|완료 조건)\b/i

export type InstrItem =
  | { kind: "check"; index: number; checked: boolean; text: string; section: "steps" | "done" }
  | { kind: "heading"; text: string; section: "steps" | "done" }
  | { kind: "text"; text: string; section: "steps" | "done" }

export interface ParsedInstructions {
  items: InstrItem[]
  steps: InstrItem[]
  doneWhen: InstrItem[]
  hasDoneWhen: boolean
  checks: { total: number; checked: number }
  doneChecks: { total: number; checked: number }
}

export function parseInstructions(markdown: string | null | undefined): ParsedInstructions {
  const items: InstrItem[] = []
  let section: "steps" | "done" = "steps"
  let hasDoneWhen = false
  let index = 0
  let inFence = false
  for (const raw of String(markdown ?? "").split("\n")) {
    if (FENCE_LINE.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      if (raw.trim()) items.push({ kind: "text", text: raw, section })
      continue
    }
    const line = raw.trim()
    if (!line) continue
    const h = HEADING.exec(line)
    if (h) {
      if (DONE_WHEN.test(h[1].trim())) {
        section = "done"
        hasDoneWhen = true
      } else {
        section = section === "done" ? "done" : "steps"
        items.push({ kind: "heading", text: h[1].trim(), section })
      }
      continue
    }
    const c = CHECKBOX_LINE.exec(raw)
    if (c) {
      items.push({ kind: "check", index: index++, checked: c[1] !== " ", text: c[2].trim(), section })
      continue
    }
    items.push({ kind: "text", text: line.replace(/^[-*+]\s+/, ""), section })
  }
  const count = (list: InstrItem[]) => {
    const checks = list.filter((i): i is Extract<InstrItem, { kind: "check" }> => i.kind === "check")
    return { total: checks.length, checked: checks.filter((i) => i.checked).length }
  }
  const steps = items.filter((i) => i.section === "steps")
  const doneWhen = items.filter((i) => i.section === "done")
  return { items, steps, doneWhen, hasDoneWhen, checks: count(items), doneChecks: count(doneWhen) }
}

/** Local optimistic toggle with the same counting rule as the backend. */
export function toggleInstruction(markdown: string, index: number): string {
  let seen = 0
  let inFence = false
  return markdown
    .split("\n")
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/.exec(line)
      if (!m) return line
      if (seen++ !== index) return line
      return `${m[1]}${m[2] === " " ? "x" : " "}${m[3]}`
    })
    .join("\n")
}
