/**
 * The unified markdown renderer (MD-UNIFY, docs/specs/20261030_markdown-unification.md).
 *
 *   import { Markdown } from "@/components/markdown"
 *   <Markdown text={task.instructions} variant="compact" />
 *
 * One policy (@teros/shared/markdown), one style layer (./styles), one
 * component (./Markdown). Surfaces map to variants:
 *
 *   chat agent reply / streaming … prose    (MessageBubble, StreamingProse)
 *   user bubble …………………………… bubble   (UserMessageBubble)
 *   tool renderers / system msgs …… plain    (12+ MCA renderers)
 *   board panels ……………………… compact  (TaskDetailPanel, previews)
 *   file viewer + To Do output …… document (MarkdownViewerWindow, TodoWindow)
 *   changelog …………………………… external (WhatsNewModal — images allowed)
 */
export { Markdown, type MarkdownProps, type MarkdownReveal } from "./Markdown"
export { parseMarkdown, parseSegments, type Segment, type HtmlSegment, type CodeSegment } from "./parse"
export { buildTagsStyles, buildWebCss, variantSpec, type MarkdownVariant, type VariantSpec } from "./styles"
export { prismStyle, SyntaxHighlighter } from "./highlight"
