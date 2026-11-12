/**
 * MarkdownRenderer
 *
 * Renders Markdown content with:
 * - Full CommonMark + GFM support (headings, lists, tables, strikethrough, task lists)
 * - Syntax highlighting for fenced code blocks via react-syntax-highlighter
 * - External image blocking — images with http(s):// src are replaced with
 *   <ImagePlaceholder> (no outbound request made)
 * - Links open in a new tab with rel="noopener noreferrer"
 *
 * Platform strategy:
 *   Web    → marked converts Markdown → HTML. Code blocks are rendered as
 *             React <SyntaxHighlighter> components interleaved with the HTML
 *             segments via a split-and-render approach. Images and links are
 *             post-processed for security.
 *
 *   Native → react-native-markdown-display with custom rules for image, link,
 *             and fence (code block) nodes.
 *
 * Typography follows the OS design system: Prody 400 headings, Saans body,
 * Reddit Mono code, the accent for links and the washes for quotes/code.
 */

import { marked, Tokenizer } from "marked"
import React, { useMemo } from "react"
import { Platform, ScrollView, Text } from "react-native"
// @ts-ignore — react-native-markdown-display types may be incomplete
import Markdown from "react-native-markdown-display"
import MarkdownIt from "markdown-it"
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter"
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism"

import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash"
import json from "react-syntax-highlighter/dist/esm/languages/prism/json"
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript"
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown"
import python from "react-syntax-highlighter/dist/esm/languages/prism/python"
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript"
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml"

import { useColors } from "../components/mca/primitives/useColors"
import { surface, type SurfaceTokens } from "../components/mca/primitives/colors"
import {
  FONT_MONO as DS_MONO,
  FONT_SANS as DS_SANS,
  FONT_SERIF as DS_SERIF,
} from "../components/mca/primitives/fonts"

SyntaxHighlighter.registerLanguage("typescript", typescript)
SyntaxHighlighter.registerLanguage("tsx", typescript)
SyntaxHighlighter.registerLanguage("javascript", javascript)
SyntaxHighlighter.registerLanguage("jsx", javascript)
SyntaxHighlighter.registerLanguage("python", python)
SyntaxHighlighter.registerLanguage("bash", bash)
SyntaxHighlighter.registerLanguage("sh", bash)
SyntaxHighlighter.registerLanguage("json", json)
SyntaxHighlighter.registerLanguage("yaml", yaml)
SyntaxHighlighter.registerLanguage("yml", yaml)
SyntaxHighlighter.registerLanguage("markdown", markdown)
SyntaxHighlighter.registerLanguage("md", markdown)

// ─── Constants ────────────────────────────────────────────────────────────────

const EXTERNAL_URL_RE = /^https?:\/\//i

// Design-system font stacks (web)
const FONT_BODY = `'${DS_SANS}', system-ui, -apple-system, sans-serif`
const FONT_HEAD = `'${DS_SERIF}', Georgia, serif`
const FONT_MONO = `'${DS_MONO}', 'JetBrains Mono', 'Fira Code', monospace`

// ─── Web CSS (theme-aware, injected/updated on theme change) ───────────────────

/**
 * Build the web CSS string using design system tokens.
 * Called whenever the theme changes; the <style> element is updated in-place.
 */
function buildWebStyles(c: SurfaceTokens, isDark: boolean): string {
  const headingColor = c.text
  const headingSecondary = c.text2
  const mutedColor = c.text3
  const borderColor = c.borderStrong
  const borderSubtle = c.border
  const stepBg = c.bgStep
  const washBg = c.wash
  const pageBg = c.bgSheet
  const bodyColor = c.text
  const codeColor = c.tint.i.tx
  const codeBg = c.tint.i.bg
  const linkColor = c.accent
  const accent = c.accent
  // The To Do kit's `tile` token (TodoWindow/ui/tokens.ts), light and dark —
  // the underlay of its bold (TodoWindow/ui/Markdown.tsx `Inline`).
  const boldTile = isDark ? "rgba(156,107,255,0.14)" : "rgba(111,39,255,0.12)"

  return `
  .md-content {
    font-family: ${FONT_BODY};
    font-size: 15px;
    line-height: 1.7;
    font-weight: 400;
    color: ${bodyColor};
    background: ${pageBg};
    padding: 28px 32px 48px;
    max-width: 860px;
    margin: 0 auto;
    box-sizing: border-box;
    width: 100%;
  }
  .md-content h1, .md-content h2, .md-content h3, .md-content h4 {
    font-family: ${FONT_HEAD};
    font-weight: 400;
    color: ${headingColor};
    letter-spacing: -0.01em;
  }
  .md-content h1 { font-size: 34px; line-height: 1.12; margin: 0.3em 0 0.5em; }
  .md-content h2 { font-size: 26px; line-height: 1.2; margin: 1.4em 0 0.5em; padding-bottom: 0.3em; border-bottom: 1px solid ${borderSubtle}; }
  .md-content h3 { font-size: 22px; line-height: 1.25; margin: 1.2em 0 0.4em; }
  .md-content h4 { font-size: 18px; line-height: 1.3; margin: 1em 0 0.3em; }
  .md-content h5, .md-content h6 { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 400; margin: 1.4em 0 0.5em; color: ${headingSecondary}; }
  .md-content p { margin: 0 0 1em; }
  /* @spec TODOOV-REQ-11 — bold reads like the To Do kit's: weight 400, text colour, violet underlay */
  .md-content strong, .md-content b { font-weight: 400; color: ${bodyColor}; background-image: linear-gradient(transparent 62%, ${boldTile} 62%); }
  .md-content ul, .md-content ol { margin: 0 0 1em 1.4em; padding: 0; }
  .md-content li { margin: 0.3em 0; }
  .md-content li::marker { color: ${mutedColor}; }
  .md-content li input[type="checkbox"] { margin-right: 6px; vertical-align: middle; accent-color: ${accent}; }
  .md-content blockquote {
    margin: 1.2em 0;
    padding: 0.6em 1.1em;
    border-left: 3px solid ${accent};
    background: ${washBg};
    color: ${headingSecondary};
    border-radius: 0 12px 12px 0;
    font-family: ${FONT_HEAD};
    font-size: 17px;
  }
  .md-content blockquote p:last-child { margin-bottom: 0; }
  .md-content hr { border: none; border-top: 1px solid ${borderSubtle}; margin: 2em 0; }
  .md-content code {
    background: ${codeBg};
    color: ${codeColor};
    padding: 2px 6px;
    border-radius: 6px;
    font-family: ${FONT_MONO};
    font-size: 0.85em;
  }
  .md-content pre {
    margin: 1em 0;
    border-radius: 12px;
    overflow: auto;
    background: ${stepBg};
    padding: 14px 16px;
  }
  .md-content pre code {
    background: none;
    color: inherit;
    padding: 0;
    border-radius: 0;
    font-size: 0.85em;
  }
  .md-content table {
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
    margin: 1.2em 0;
    font-size: 13px;
    overflow: auto;
    display: block;
  }
  .md-content th {
    background: ${washBg};
    border-bottom: 1px solid ${borderColor};
    padding: 8px 12px;
    text-align: left;
    font-weight: 400;
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: ${headingSecondary};
  }
  .md-content td {
    border-bottom: 1px solid ${borderSubtle};
    padding: 9px 12px;
    vertical-align: top;
  }
  .md-content tr:last-child td { border-bottom: none; }
  .md-content a { color: ${linkColor}; text-decoration: none; }
  .md-content a:hover { text-decoration: underline; text-underline-offset: 3px; }
  .md-content img { max-width: 100%; border-radius: 12px; }
  /* strikethrough disabled — tilde renders literal (MD-STRIKE-1) */
  .md-content .md-code-block {
    margin: 1em 0;
    border-radius: 12px;
    overflow: hidden;
    ${isDark ? "" : `border: 1px solid ${borderSubtle};`}
  }
  .md-img-placeholder {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 10px 14px;
    margin: 4px 0;
    border: 1px dashed ${c.tint.i.bd};
    border-radius: 12px;
    background: ${c.tint.i.bg};
    font-size: 12px;
    color: ${c.tint.i.tx};
    font-family: inherit;
    max-width: 100%;
    box-sizing: border-box;
  }
  .md-img-placeholder-label {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .md-img-placeholder-alt {
    font-family: ${FONT_HEAD};
    color: ${headingSecondary};
  }
  .md-img-placeholder-url {
    font-family: ${FONT_MONO};
    font-size: 11px;
    color: ${c.text3};
    word-break: break-all;
  }
`
}

let webStyleElement: HTMLStyleElement | null = null
let webStyleThemeKey = ""

function ensureWebStyles(c: SurfaceTokens, isDark: boolean) {
  if (typeof document === "undefined") return
  const themeKey = isDark ? "dark" : "light"
  const css = buildWebStyles(c, isDark)

  if (webStyleElement && webStyleThemeKey === themeKey) return // already up-to-date

  if (webStyleElement) {
    // Update existing element (theme switched)
    webStyleElement.textContent = css
    webStyleThemeKey = themeKey
    return
  }

  // First injection
  const style = document.createElement("style")
  style.id = "md-viewer-styles"
  style.textContent = css
  document.head.appendChild(style)
  webStyleElement = style
  webStyleThemeKey = themeKey
}

// ─── Web renderer: split HTML into segments + code blocks ─────────────────────

interface HtmlSegment {
  type: "html"
  content: string
}

interface CodeSegment {
  type: "code"
  lang: string
  code: string
}

type Segment = HtmlSegment | CodeSegment

/**
 * Parse Markdown into an array of segments:
 * - 'html' segments: rendered HTML from marked (no code blocks)
 * - 'code' segments: fenced code blocks with language info
 *
 * This lets us render HTML via dangerouslySetInnerHTML and code blocks
 * via <SyntaxHighlighter> React components, interleaved correctly.
 */
// @fixme nira - 2026-10-19 : disable strikethrough tokenizer — Pablo doesn't use
// ~~del~~ and the tilde must render literal (~50ms, aprox~, paths, etc.)
const _noStrikeTokenizer = new Tokenizer()
_noStrikeTokenizer.del = function () {
  return undefined
}

function parseSegments(markdownText: string): Segment[] {
  // Use marked's lexer to walk tokens
  marked.setOptions({ gfm: true, breaks: false, tokenizer: _noStrikeTokenizer })

  const tokens = marked.lexer(markdownText)
  const segments: Segment[] = []
  let htmlAccum = ""

  const flushHtml = () => {
    if (htmlAccum.trim()) {
      // Post-process: block external images, add target="_blank" to links
      let safe = htmlAccum.replace(
        /<img([^>]*?)src=["'](https?:\/\/[^"']+)["']([^>]*?)>/gi,
        (_match, before, src, after) => {
          const altMatch = (before + after).match(/alt=["']([^"']*)["']/i)
          const alt = altMatch ? altMatch[1] : ""
          return `<span class="md-img-placeholder"><span class="md-img-placeholder-label"><i class="ph ph-image" aria-hidden="true"></i> External image blocked</span>${alt ? `<span class="md-img-placeholder-alt">${alt}</span>` : ""}<span class="md-img-placeholder-url">${src}</span></span>`
        },
      )
      safe = safe.replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" ')
      segments.push({ type: "html", content: safe })
      htmlAccum = ""
    }
  }

  for (const token of tokens) {
    if (token.type === "code") {
      flushHtml()
      segments.push({
        type: "code",
        lang: (token as any).lang?.trim() ?? "",
        code: (token as any).text ?? "",
      })
    } else {
      // Render this token back to HTML
      const html = marked.parser([token as any])
      htmlAccum += html
    }
  }

  flushHtml()
  return segments
}

interface WebMarkdownRendererProps {
  content: string
  c: SurfaceTokens
  isDark: boolean
}

function WebMarkdownRenderer({ content, c, isDark }: WebMarkdownRendererProps) {
  ensureWebStyles(c, isDark)

  const segments = useMemo(() => parseSegments(content), [content])

  return (
    <div className="md-content">
      {segments.map((seg, i) => {
        if (seg.type === "html") {
          return (
            <div
              key={i}
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: seg.content }}
            />
          )
        }
        // Code block with syntax highlighting
        return (
          <div key={i} className="md-code-block">
            <SyntaxHighlighter
              language={seg.lang || "text"}
              style={isDark ? oneDark : oneLight}
              customStyle={{
                borderRadius: 12,
                fontSize: 13,
                margin: 0,
                lineHeight: 1.55,
                fontFamily: FONT_MONO,
                background: c.bgStep,
                padding: "14px 16px",
              }}
              codeTagProps={{ style: { fontFamily: FONT_MONO } }}
              PreTag="div"
              showLineNumbers={false}
            >
              {seg.code}
            </SyntaxHighlighter>
          </div>
        )
      })}
    </div>
  )
}

// ─── Native renderer ───────────────────────────────────────────────────────────

/**
 * Build native markdown styles using design system tokens.
 * Called inside the component so useColors() values are available.
 */
function buildNativeStyles(c: SurfaceTokens, _isDark: boolean) {
  const headingColor = c.text
  const headingSecondary = c.text2
  const mutedColor = c.text3
  const borderColor = c.border
  const stepBg = c.bgStep
  const codeBg = c.tint.i.bg
  const codeColor = c.tint.i.tx
  const linkColor = c.accent

  return {
    body: {
      color: c.text,
      fontSize: 15,
      lineHeight: 24,
      fontFamily: DS_SANS,
      fontWeight: "400" as const,
    },
    heading1: {
      fontSize: 32,
      fontFamily: DS_SERIF,
      fontWeight: "400" as const,
      marginTop: 8,
      marginBottom: 10,
      color: headingColor,
    },
    heading2: {
      fontSize: 24,
      fontFamily: DS_SERIF,
      fontWeight: "400" as const,
      marginTop: 20,
      marginBottom: 8,
      color: headingColor,
    },
    heading3: {
      fontSize: 20,
      fontFamily: DS_SERIF,
      fontWeight: "400" as const,
      marginTop: 16,
      marginBottom: 6,
      color: headingColor,
    },
    heading4: {
      fontSize: 17,
      fontFamily: DS_SERIF,
      fontWeight: "400" as const,
      marginTop: 12,
      marginBottom: 4,
      color: headingColor,
    },
    heading5: {
      fontSize: 10,
      letterSpacing: 1.8,
      textTransform: "uppercase" as const,
      fontWeight: "400" as const,
      marginTop: 12,
      marginBottom: 6,
      color: headingSecondary,
    },
    heading6: {
      fontSize: 10,
      letterSpacing: 1.8,
      textTransform: "uppercase" as const,
      fontWeight: "400" as const,
      marginTop: 12,
      marginBottom: 6,
      color: mutedColor,
    },
    paragraph: { marginTop: 0, marginBottom: 10 },
    strong: { fontWeight: "400" as const, color: headingColor },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: c.accent,
      paddingLeft: 14,
      paddingVertical: 6,
      marginVertical: 10,
      backgroundColor: c.wash,
      borderRadius: 10,
    },
    code_inline: {
      backgroundColor: codeBg,
      color: codeColor,
      paddingHorizontal: 5,
      paddingVertical: 2,
      borderRadius: 6,
      fontFamily: DS_MONO,
      fontSize: 13,
    },
    fence: {
      backgroundColor: stepBg,
      borderRadius: 12,
      padding: 14,
      marginVertical: 10,
      fontFamily: DS_MONO,
      fontSize: 13,
    },
    link: { color: linkColor },
    hr: { borderTopWidth: 1, borderTopColor: borderColor, marginVertical: 16 },
    table: { borderWidth: 0, marginVertical: 10 },
    thead: { backgroundColor: c.wash },
    th: {
      padding: 8,
      fontWeight: "400" as const,
      fontSize: 10,
      letterSpacing: 1.8,
      textTransform: "uppercase" as const,
      borderBottomWidth: 1,
      borderColor: borderColor,
      color: headingSecondary,
    },
    td: { padding: 9, borderBottomWidth: 1, borderColor: borderColor },
    bullet_list: { marginVertical: 8 },
    ordered_list: { marginVertical: 8 },
    list_item: { marginVertical: 3 },
    // strikethrough disabled — tilde renders literal (MD-STRIKE-1)
  }
}

/**
 * Build native rules with theme-aware colors.
 */
function buildNativeRules(c: SurfaceTokens, isDark: boolean) {
  const linkColor = c.accent
  return {
    image: (node: any, _children: any, _parent: any, _styles: any) => {
      const src: string = node.attributes?.src ?? ""
      const alt: string = node.attributes?.alt ?? ""
      const isExternal = EXTERNAL_URL_RE.test(src)
      const { ImagePlaceholder } = require("../windows/MarkdownViewerWindow/components/ImagePlaceholder")
      return <ImagePlaceholder key={node.key} alt={alt} url={src} local={!isExternal} />
    },
    link: (node: any, children: any, _parent: any, styles: any) => {
      const href: string = node.attributes?.href ?? ""
      return (
        <Text
          key={node.key}
          style={[styles.link, { color: linkColor }]}
          onPress={() => {
            if (typeof window !== "undefined") {
              window.open(href, "_blank", "noopener,noreferrer")
            }
          }}
        >
          {children}
        </Text>
      )
    },
    fence: (node: any, _children: any, _parent: any, _styles: any) => {
      const lang: string = node.sourceInfo?.trim() ?? ""
      const code: string = node.content ?? ""
      return (
        <SyntaxHighlighter
          key={node.key}
          language={lang || "text"}
          style={isDark ? oneDark : oneLight}
          customStyle={{ borderRadius: 12, fontSize: 13, margin: 8, background: c.bgStep }}
          PreTag="div"
        >
          {code}
        </SyntaxHighlighter>
      )
    },
  }
}

// ─── Public component ──────────────────────────────────────────────────────────

// @fixme nira - 2026-10-19 : disable strikethrough rule in markdown-it — the tilde
// must render literal in agent output (Pablo's request, MD-STRIKE-1)
const _markdownItNoStrike = MarkdownIt({ typographer: true }).disable("strikethrough")

interface MarkdownRendererProps {
  content: string
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const c = useColors()
  const isDark = c.bgPage === surface.dark.bgPage

  if (Platform.OS === "web") {
    return <WebMarkdownRenderer content={content} c={c} isDark={isDark} />
  }

  const nativeStyles = buildNativeStyles(c, isDark)
  const nativeRules = buildNativeRules(c, isDark)

  // Native: react-native-markdown-display with custom rules
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bgSheet }}
      contentContainerStyle={{ padding: 20 }}
    >
      <Markdown rules={nativeRules} style={nativeStyles} markdownit={_markdownItNoStrike}>
        {content}
      </Markdown>
    </ScrollView>
  )
}
