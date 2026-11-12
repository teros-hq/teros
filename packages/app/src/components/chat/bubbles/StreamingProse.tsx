/**
 * StreamingProse — the agent's reply while it streams (type-in, DS Motion),
 * rendered "parse ahead, reveal behind":
 *
 *  1. The source is parsed AHEAD, held back only at the first OPEN inline
 *     construction ('**bo', '[link', '`code'): a heading is a heading from
 *     its first char, a list item a list item, and bold appears bold —
 *     never as literal asterisks that pop later.
 *  2. The reveal runs over the RENDERED text (typeInReveal.ts): a count of
 *     rendered chars grows on the typewriter's rhythm (useRevealCount), the
 *     document is cut there, and the chars revealed by the latest ticks
 *     enter blurred and settle in place (useTypewriterBoundary over the
 *     rendered text, no syntax scan).
 *  3. Stream end: the hold-back lifts (whatever is still open renders as
 *     marked would) and the reveal drains to the last char.
 *
 * Known residue: constructs decided by a LATER line (a table needs its
 * delimiter row, a setext heading its underline) still re-type when that
 * line arrives — the count never snaps, so the text keeps flowing.
 */
import React, { useMemo, useRef } from "react"
import {
  createSyntaxScan,
  firstOpenSyntax,
  syntaxScanPush,
  useRevealCount,
  useTypewriterBoundary,
  type SyntaxScanState,
} from "../../../hooks/useTypewriter"
import { MarkdownContent, type MarkdownVariant, parseMarkdown } from "./MarkdownContent"
import { renderedText } from "./typeInReveal"

export function StreamingProse({
  text,
  isStreaming,
  variant = "prose",
}: {
  text: string
  isStreaming: boolean
  variant?: MarkdownVariant
}) {
  // Hold back the source at the first open inline construction while the
  // stream is live (incremental scan; rebuilt when the text is rewritten).
  const scanRef = useRef<{ st: SyntaxScanState; text: string }>({
    st: createSyntaxScan(),
    text: "",
  })
  const source = useMemo(() => {
    if (!isStreaming) return text
    const cur = scanRef.current
    if (!text.startsWith(cur.text)) {
      cur.st = createSyntaxScan()
      cur.text = ""
    }
    syntaxScanPush(cur.st, text, cur.text.length)
    cur.text = text
    const open = firstOpenSyntax(cur.st)
    return open === null ? text : text.slice(0, open)
  }, [text, isStreaming])

  const html = parseMarkdown(source)
  const plain = useMemo(() => renderedText(html), [html])
  const count = useRevealCount(plain.length, isStreaming)
  const shown = useMemo(() => plain.slice(0, count), [plain, count])
  const boundary = useTypewriterBoundary(shown, isStreaming, { scanSyntax: false })
  const animating = isStreaming || count < plain.length || boundary !== null
  return (
    <MarkdownContent
      text={source}
      variant={variant}
      reveal={animating ? { end: count, boundary } : null}
    />
  )
}
