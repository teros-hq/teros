// ============================================================================
// COMPACT MARKDOWN — the board surface of the unified markdown renderer
// (MD-UNIFY v2, step 2). Thin wrapper over the `compact` variant of
// components/markdown; public API unchanged (call-sites untouched).
// ============================================================================

import { Markdown } from "../../components/markdown"
import { useColors } from "../../components/mca/primitives/useColors"

interface CompactMarkdownProps {
  text: string
  /** Base font size (default: 13 — the `sm` step; the compact variant is 13) */
  fontSize?: number
  /** Base text color (defaults to theme secondary text) */
  color?: string
  /** Width override — defaults to container width from useWindowDimensions */
  width?: number
}

export function CompactMarkdown({ text, fontSize = 13, color: colorProp, width }: CompactMarkdownProps) {
  const c = useColors()
  return (
    <Markdown
      text={text}
      variant="compact"
      scale={fontSize / 13}
      color={colorProp ?? c.text2}
      width={width}
    />
  )
}
