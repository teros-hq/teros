/**
 * jsonHighlight — shared JSON syntax highlight for the FVU widget.
 *
 * Reuses the SAME highlighter the MarkdownViewer uses for fenced code
 * (react-syntax-highlighter / PrismLight + oneDark|oneLight), per the spec's
 * Implementation Notes. Exported as a pair so FileTypeBody can highlight JSON
 * with zero extra dependencies and identical theming to MD code blocks.
 */
// Deep imports: the package root re-exports every highlighter (highlight.js + all of Prism).
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light"
import oneDark from "react-syntax-highlighter/dist/esm/styles/prism/one-dark"
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light"
import json from "react-syntax-highlighter/dist/esm/languages/prism/json"
import { useMcaTheme } from "../../mca/primitives/useColors"

SyntaxHighlighter.registerLanguage("json", json)

export { SyntaxHighlighter }

/** Theme-aware Prism style for JSON bodies (dark-first per the DS). */
export const syntaxTheme = oneDark

/** Hook variant when the component can read the live theme. */
export function useSyntaxTheme() {
  return useMcaTheme() === "dark" ? oneDark : oneLight
}
