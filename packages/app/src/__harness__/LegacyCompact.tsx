// ============================================================================
// COMPACT MARKDOWN RENDERER
// For use in compact panels like TaskDetailPanel
// Uses marked + react-native-render-html with the OS prototype type steps:
// Saans body, Reddit Mono code, 400 weight everywhere (hierarchy by size).
// ============================================================================

import { marked, Tokenizer } from "marked"
import { useMemo } from "react"
import { Platform, useWindowDimensions } from "react-native"
import RenderHtml, { defaultSystemFonts } from "react-native-render-html"
import { FONT_MONO, FONT_SANS, FONT_SERIF } from "../components/mca/primitives/fonts"

// RenderHtml only honours fontFamily values registered as system fonts.
const BRAND_FONTS = [...defaultSystemFonts, FONT_SANS, FONT_SERIF, FONT_MONO]
import { useColors } from "../components/mca/primitives/useColors"

// @fixme nira - 2026-10-19 : disable strikethrough tokenizer — the tilde must
// render literal in agent output (Pablo's request, MD-STRIKE-1)
const _noStrikeTokenizer = new Tokenizer()
_noStrikeTokenizer.del = function () {
  return undefined
}
marked.setOptions({
  breaks: true,
  gfm: true,
  tokenizer: _noStrikeTokenizer,
})

interface CompactMarkdownProps {
  text: string
  /** Base font size (default: 13 — the `sm` step) */
  fontSize?: number
  /** Base text color (defaults to theme secondary text) */
  color?: string
  /** Width override — defaults to container width from useWindowDimensions */
  width?: number
}

/**
 * Renders markdown in a compact, muted style suitable for task description panels.
 */
export function LegacyCompact({ text, fontSize = 13, color: colorProp }: CompactMarkdownProps) {
  const c = useColors()
  const color = colorProp ?? c.text2
  const { width: windowWidth } = useWindowDimensions()

  const html = useMemo(() => marked.parse(text) as string, [text])

  const tagsStyles: any = useMemo(
    () => ({
      body: {
        color,
        fontSize,
        fontFamily: FONT_SANS,
        fontWeight: "400",
        lineHeight: Math.round(fontSize * 1.5),
        margin: 0,
        padding: 0,
        ...(Platform.OS === "web" ? { userSelect: "text", cursor: "text" } : {}),
      },
      p: {
        marginTop: 0,
        marginBottom: 6,
      },
      // Emphasis never goes bold in the DS — it steps up to the text colour.
      strong: {
        fontWeight: "400" as const,
        color: c.text,
      },
      b: {
        fontWeight: "400" as const,
        color: c.text,
      },
      em: {
        fontStyle: "italic" as const,
      },
      code: {
        backgroundColor: c.wash2,
        paddingHorizontal: 4,
        paddingVertical: 1,
        borderRadius: 4,
        fontFamily: FONT_MONO,
        fontSize: Math.max(10, fontSize - 1),
        color: c.text,
      },
      pre: {
        backgroundColor: c.nest,
        padding: 10,
        borderRadius: 10,
        marginVertical: 6,
        fontFamily: FONT_MONO,
        fontSize: Math.max(10, fontSize - 1),
      },
      ul: {
        marginVertical: 2,
        paddingLeft: 18,
      },
      ol: {
        marginVertical: 2,
        paddingLeft: 18,
      },
      li: {
        marginVertical: 1,
      },
      a: {
        color: c.accent,
        textDecorationLine: "none" as const,
      },
      blockquote: {
        borderLeftWidth: 2,
        borderLeftColor: c.borderAccent,
        marginVertical: 6,
        marginLeft: 0,
        paddingLeft: 10,
        color: c.text3,
      },
      hr: {
        height: 1,
        backgroundColor: c.border,
        borderWidth: 0,
        marginVertical: 8,
      },
      h1: {
        marginTop: 8,
        marginBottom: 4,
        fontFamily: FONT_SERIF,
        fontWeight: "400" as const,
        color: c.text,
        fontSize: fontSize + 5,
        lineHeight: Math.round((fontSize + 5) * 1.25),
      },
      h2: {
        marginTop: 8,
        marginBottom: 4,
        fontFamily: FONT_SERIF,
        fontWeight: "400" as const,
        color: c.text,
        fontSize: fontSize + 3,
        lineHeight: Math.round((fontSize + 3) * 1.25),
      },
      h3: {
        marginTop: 6,
        marginBottom: 2,
        fontFamily: FONT_SANS,
        fontWeight: "400" as const,
        color: c.text,
        fontSize: fontSize + 1,
      },
      h4: {
        marginTop: 6,
        marginBottom: 2,
        fontFamily: FONT_SANS,
        fontWeight: "400" as const,
        color: c.text,
        fontSize,
        textTransform: "uppercase" as const,
        letterSpacing: 1,
      },
      table: {
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 6,
        marginVertical: 6,
      },
      th: {
        fontWeight: "400" as const,
        color: c.text3,
        fontSize: Math.max(10, fontSize - 2),
        textTransform: "uppercase" as const,
        letterSpacing: 1,
        paddingHorizontal: 8,
        paddingVertical: 4,
      },
      td: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderTopWidth: 1,
        borderTopColor: c.border,
      },
    }),
    [fontSize, color, c],
  )

  // On web, use a custom <pre> renderer to allow horizontal scroll
  const renderers: any = useMemo(
    () =>
      Platform.OS === "web"
        ? {
            pre: ({ tnode }: any) => {
              const extractText = (node: any): string => {
                if (!node) return ""
                if (node.type === "text") return node.data || ""
                if (node.children) return node.children.map(extractText).join("")
                return ""
              }
              return (
                <div
                  style={{
                    backgroundColor: c.nest,
                    padding: 10,
                    borderRadius: 10,
                    marginTop: 6,
                    marginBottom: 6,
                    overflowX: "auto",
                    whiteSpace: "pre",
                  }}
                >
                  <code
                    style={{
                      fontFamily: `'${FONT_MONO}', monospace`,
                      fontSize: Math.max(10, fontSize - 1),
                      lineHeight: 1.5,
                      color: c.text2,
                      whiteSpace: "pre",
                      wordWrap: "normal",
                      overflowWrap: "normal",
                    }}
                  >
                    {extractText(tnode.domNode)}
                  </code>
                </div>
              )
            },
          }
        : {},
    [fontSize, c],
  )

  return (
    <RenderHtml
      systemFonts={BRAND_FONTS}
      contentWidth={windowWidth}
      source={{ html }}
      tagsStyles={tagsStyles}
      defaultTextProps={{ selectable: true }}
      renderers={renderers}
    />
  )
}
