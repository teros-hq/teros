/**
 * mca.teros.terminal — Tool Call Renderer
 *
 * Every terminal tool keeps the standard card (DefaultToolCallRenderer).
 * When a result says the coding agent in the session is waiting for an
 * answer (reason "blocked": terminal-wait, terminal-prompt, terminal-send-key,
 * terminal-screen with a question), the needs-you card follows it: the
 * question, its numbered options as buttons and "Open floating".
 */

import type React from "react"
import { useMemo } from "react"
import { DefaultToolCallRenderer } from "../../DefaultToolCallRenderer"
import { parseOutput } from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import { NeedsYouCard } from "./NeedsYouCard"
import { parseTerminalQuestion } from "./needsYou"

/** The structured result the terminal tools return (mcas/mca.teros.terminal waitData). */
interface TerminalResult {
  terminalId?: string
  reason?: string
  message?: string | null
  question?: string | null
  screen?: string | null
}

function unwrap(output?: string): TerminalResult | null {
  if (!output) return null
  const parsed = parseOutput<{ structuredContent?: TerminalResult } | TerminalResult>(output)
  if (!parsed || typeof parsed !== "object") return null
  if ("structuredContent" in parsed && parsed.structuredContent) return parsed.structuredContent
  return parsed as TerminalResult
}

/** The needs-you part of a terminal tool result, if it asks for the person. */
export function needsYouOf(
  props: Pick<ToolCallRendererProps, "status" | "output" | "input">,
): { terminalId: string; screen: string | null; hint: string | null } | null {
  if (props.status !== "completed") return null
  const r = unwrap(props.output)
  if (!r) return null
  const blocked = r.reason === "blocked" || (!!r.question && r.reason !== "done")
  const terminalId = r.terminalId ?? (props.input?.terminalId as string | undefined)
  if (!blocked || !terminalId) return null
  return { terminalId, screen: r.screen ?? null, hint: r.question ?? r.message ?? null }
}

export function TerminalToolCallRenderer(props: ToolCallRendererProps): React.ReactNode {
  const { status, output, input } = props
  const need = useMemo(() => needsYouOf({ status, output, input }), [status, output, input])
  const question = useMemo(
    () => (need ? parseTerminalQuestion(need.screen, need.hint) : null),
    [need],
  )
  return (
    <>
      <DefaultToolCallRenderer {...props} />
      {need && question ? <NeedsYouCard terminalId={need.terminalId} question={question} /> : null}
    </>
  )
}

export default TerminalToolCallRenderer
