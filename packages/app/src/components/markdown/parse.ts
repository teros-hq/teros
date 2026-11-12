/**
 * Parse layer of the unified markdown renderer (MD-UNIFY, D1/D3).
 *
 * The POLICY lives in @teros/shared/markdown (gfm, breaks, noStrike, no raw
 * HTML, safe URLs, checkbox glyphs) — this module adds the app-side concerns:
 *
 *   · segmentation: walk the token stream and split it into html-segments and
 *     code-segments so fenced blocks render as <SyntaxHighlighter> React
 *     components interleaved with the HTML (the viewer's proven approach —
 *     now for every surface).
 *   · external images: non-`external` variants replace http(s) <img> with a
 *     placeholder span (no outbound request) — the viewer's security rule,
 *     extended to chat/board/todo.
 *   · cache: parseMarkdown() memoizes the last source→html pair (the
 *     streaming reveal path measures and renders the SAME html; one parse).
 *
 * Never import `marked` directly here — always the shared instance.
 */
import { terosMarkdown } from "@teros/shared/markdown"

export interface HtmlSegment {
  type: "html"
  content: string
}

export interface CodeSegment {
  type: "code"
  lang: string
  code: string
}

export type Segment = HtmlSegment | CodeSegment

const EXTERNAL_URL_RE = /^https?:\/\//i

/** The blocked-image placeholder (viewer recipe, class names kept). */
function imagePlaceholder(src: string, alt: string): string {
  return (
    `<span class="md-img-placeholder"><span class="md-img-placeholder-label">` +
    `External image blocked</span>` +
    (alt ? `<span class="md-img-placeholder-alt">${alt}</span>` : "") +
    `<span class="md-img-placeholder-url">${src}</span></span>`
  )
}

/** Replace external <img> with the placeholder. Local/relative srcs pass. */
function blockExternalImages(html: string): string {
  return html.replace(
    /<img\s[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi,
    (match, src: string, alt: string) => {
      if (!EXTERNAL_URL_RE.test(src)) return match
      return imagePlaceholder(esc(src), esc(alt ?? ""))
    },
  )
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/**
 * Parse markdown into segments: HTML runs and fenced code blocks. Code blocks
 * become `code` segments so the renderer draws them with Prism; everything
 * else is policy-HTML (already stripped of raw HTML by the shared instance).
 */
export function parseSegments(
  source: string,
  opts: { allowExternalImages?: boolean } = {},
): Segment[] {
  const tokens = terosMarkdown.lexer(source)
  const segments: Segment[] = []
  let htmlAccum = ""

  const flushHtml = () => {
    if (htmlAccum.trim()) {
      let html = htmlAccum
      if (!opts.allowExternalImages) html = blockExternalImages(html)
      segments.push({ type: "html", content: html })
      htmlAccum = ""
    }
  }

  for (const token of tokens as any[]) {
    if (token.type === "code") {
      flushHtml()
      segments.push({
        type: "code",
        lang: token.lang?.trim() ?? "",
        code: token.text ?? "",
      })
    } else {
      htmlAccum += terosMarkdown.parser([token])
    }
  }
  flushHtml()
  return segments
}

/**
 * One policy-html string (no segmentation) for the RenderHtml paths — native
 * and the chat variants on web, where fenced code renders as the styled <pre>.
 * Non-`external` variants block external images.
 */
export function parseHtml(source: string, opts: { allowExternalImages?: boolean } = {}): string {
  const html = terosMarkdown.parse(source) as string
  return opts.allowExternalImages ? html : blockExternalImages(html)
}

/**
 * Single-entry parse cache. The streaming path (StreamingProse/typeInReveal)
 * needs the html to measure the reveal count and MarkdownContent needs the
 * same html to render — same string, same render, one parse.
 */
let lastSource: string | null = null
let lastHtml = ""

export function parseMarkdown(source: string): string {
  if (source !== lastSource) {
    lastSource = source
    lastHtml = terosMarkdown.parse(source) as string
  }
  return lastHtml
}
