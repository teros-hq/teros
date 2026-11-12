/**
 * Prism registry of the unified markdown renderer (MD-UNIFY, D2).
 *
 * One place registers the languages every surface can highlight — before,
 * the viewer and the changelog each kept their own copy of the same list.
 * PrismLight keeps the bundle small (only registered languages ship).
 */
// Deep imports: the package root re-exports every highlighter (highlight.js + all of Prism).
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light"
import oneDark from "react-syntax-highlighter/dist/esm/styles/prism/one-dark"
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light"

import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash"
import json from "react-syntax-highlighter/dist/esm/languages/prism/json"
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript"
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown"
import python from "react-syntax-highlighter/dist/esm/languages/prism/python"
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript"
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml"

SyntaxHighlighter.registerLanguage("typescript", typescript)
SyntaxHighlighter.registerLanguage("tsx", typescript)
SyntaxHighlighter.registerLanguage("javascript", javascript)
SyntaxHighlighter.registerLanguage("jsx", javascript)
SyntaxHighlighter.registerLanguage("js", javascript)
SyntaxHighlighter.registerLanguage("python", python)
SyntaxHighlighter.registerLanguage("py", python)
SyntaxHighlighter.registerLanguage("bash", bash)
SyntaxHighlighter.registerLanguage("sh", bash)
SyntaxHighlighter.registerLanguage("shell", bash)
SyntaxHighlighter.registerLanguage("json", json)
SyntaxHighlighter.registerLanguage("yaml", yaml)
SyntaxHighlighter.registerLanguage("yml", yaml)
SyntaxHighlighter.registerLanguage("markdown", markdown)
SyntaxHighlighter.registerLanguage("md", markdown)

export { SyntaxHighlighter, oneDark, oneLight }

/** Theme-aware Prism style pick. */
export function prismStyle(isDark: boolean) {
  return isDark ? oneDark : oneLight
}
