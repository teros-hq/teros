/**
 * MarkdownContent — the chat / MCA-renderer surface of the unified markdown
 * renderer (MD-UNIFY v2, step 4). Thin wrapper over components/markdown with
 * the chat voices as variants:
 *
 *   prose  — the agent reply (Prody/Ivory 17/1.45, serif h3, caps h4, cards)
 *   bubble — the user bubble (Saans 16/1.45 on the mint glow)
 *   plain  — everything else (tool renderers, system messages)
 *
 * Public API unchanged (19 call-sites untouched): MarkdownContent,
 * PreRenderer, parseMarkdown, MarkdownReveal, MarkdownVariant. `~` stays
 * literal — the policy lives in @teros/shared/markdown (MD-STRIKE-1).
 */
import { Markdown } from "../../markdown"

export { PreRenderer } from "../../markdown/richRenderers"
export { parseMarkdown } from "../../markdown/parse"
export type { MarkdownReveal } from "../../markdown"

/** Visual role: agent `prose`, user `bubble`, or the plain tool-renderer look. */
export type MarkdownVariant = "prose" | "bubble" | "plain"

/** Chat compact mode renders at ~11px body. */
const COMPACT_SCALE = 0.73

export function MarkdownContent({
  text,
  compact = false,
  reveal,
  variant = "plain",
  color,
}: {
  text: string
  compact?: boolean
  reveal?: import("../../markdown").MarkdownReveal | null
  variant?: MarkdownVariant
  /** Body colour override (the user bubble reads Main/800 on the mint glow). */
  color?: string
}) {
  return (
    <Markdown
      text={text}
      variant={variant}
      scale={compact ? COMPACT_SCALE : 1}
      reveal={reveal}
      color={color}
    />
  )
}
