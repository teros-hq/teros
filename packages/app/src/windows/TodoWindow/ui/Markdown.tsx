/**
 * The To Do markdown viewer (docs/specs/todo/markdown.md): task inputs/outputs
 * and the log. Since MD-UNIFY v2 (step 5) a thin wrapper over the `document`
 * variant of components/markdown — the hand-written line parser is retired, so
 * nested lists, headings h1–h6, images policy and the sanitizer come from the
 * one shared policy (@teros/shared/markdown). `~` stays literal (MD-STRIKE-1).
 *
 * Public API unchanged: `<Markdown source size lh tight />` (3 call-sites).
 * @spec TODOMD-REQ-1
 */
import React from "react"
import { View } from "react-native"

import { Markdown as UnifiedMarkdown } from "../../../components/markdown"

/** The `document` variant is drawn at 15px; the To Do surfaces ask for 14 (log: 13). */
const DOCUMENT_SIZE = 15

export function Markdown({
  source,
  size = 14,
  tight,
}: {
  source: string
  size?: number
  /** Legacy line-height prop (the variant carries its own rhythm). */
  lh?: number
  /** Inline contexts (log entries, TODOMD-REQ-4): no trailing margin after the last block. */
  tight?: boolean
}) {
  return (
    <View style={[{ minWidth: 0 }, tight ? { marginBottom: -8 } : null]}>
      <UnifiedMarkdown text={source ?? ""} variant="document" scale={size / DOCUMENT_SIZE} />
    </View>
  )
}
