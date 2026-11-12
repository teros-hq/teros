import { marked, Tokenizer } from "marked"
import { surface } from "../components/mca/primitives/colors"
import { useColors } from "../components/mca/primitives/useColors"
import { FONT_MONO, FONT_SANS, FONT_SERIF, FONT_SERIF_TEXT } from "../components/mca/primitives/fonts"

// RenderHtml drops any fontFamily it does not know as a "system font" — the
// brand faces must be registered or every prose paragraph falls back to the
// platform sans.
const BRAND_FONTS = [...defaultSystemFonts, FONT_SANS, FONT_SERIF, FONT_SERIF_TEXT, FONT_MONO]
import { useMemo } from "react"
import { Platform, useWindowDimensions } from "react-native"
import RenderHtml, { defaultSystemFonts } from "react-native-render-html"
import { buildTypeInRenderers, TYPEIN_CSS } from "../components/chat/bubbles/TypeIn"
import { revealHtml } from "../components/chat/bubbles/typeInReveal"

// Table plugin for native platforms
import TableRenderer, { tableModel } from "@native-html/table-plugin"
import WebView from "react-native-webview"

// Configure marked for safe rendering.
// @fixme nira - 2026-10-19 : disable strikethrough tokenizer — Pablo doesn't use
// ~~del~~ and the tilde must render literal (~50ms, aprox~, paths, etc.)
const _noStrikeTokenizer = new Tokenizer()
_noStrikeTokenizer.del = function () {
  return undefined
}
marked.setOptions({
  breaks: true,
  gfm: true,
  tokenizer: _noStrikeTokenizer,
})

/**
 * Markdown looks (OS prototype, design-testing Oct 2026):
 *   prose  — the agent reply (`.prose`): Prody 17/1.45, serif h3, caps h4,
 *            sans lists with accent markers, cards for quotes / code.
 *   bubble — the user bubble (`.bubble`): Saans 16/1.45 on the mint glow.
 *   plain  — everything else (tool renderers): Saans 15/24, unchanged scale.
 */
export type MarkdownVariant = "prose" | "bubble" | "plain"

const GRAD_MONO = "linear-gradient(135deg, #6F27FF 0%, #9C6BFF 100%)"

// Build theme-adaptive HTML styles for react-native-render-html.
// Called inside the component so it has access to useColors() tokens.
function buildTagsStyles(
  c: ReturnType<typeof useColors>,
  compact = false,
  isDarkMode = false,
  variant: MarkdownVariant = "plain",
  color?: string,
): any {
  const scale = compact ? 0.73 : 1 // ~11px body when compact
  const prose = variant === "prose"
  const bubble = variant === "bubble"
  const bodyFont = prose ? FONT_SERIF_TEXT : FONT_SANS
  const bodySize = prose ? 17 : bubble ? 16 : 15
  const bodyLine = prose ? 25 : bubble ? 23 : 24
  const blockGap = prose ? 14 : 8
  return {
    body: {
      color: color ?? c.text,
      fontFamily: bodyFont,
      fontWeight: prose ? ("300" as const) : ("400" as const), // Ivory Light for prose
      fontSize: Math.round(bodySize * scale),
      lineHeight: Math.round(bodyLine * scale),
      ...(prose ? { letterSpacing: 0.34 } : {}),
      ...(Platform.OS === "web" ? { userSelect: "text", cursor: "text" } : {}),
    },
    p: {
      marginTop: 0,
      marginBottom: Math.round(blockGap * scale),
    },
    // Never bold (DS): emphasis is the accent, upright — `.prose em`.
    strong: prose
      ? { fontWeight: "400" as const, color: c.accent }
      : { fontWeight: "400" as const, color: color ?? c.text },
    em: prose
      ? { fontStyle: "normal" as const, color: c.accent }
      : { fontStyle: "italic" as const },
    code: {
      backgroundColor: c.navActive,
      color: c.accent,
      paddingHorizontal: Math.round(6 * scale),
      paddingVertical: 1,
      borderRadius: 4,
      fontFamily: FONT_MONO,
      fontSize: Math.round(13 * scale),
      letterSpacing: 0,
    },
    pre: {
      // A card on the sheet (`.prose .md-pre`): one step off, violet lift
      // on web, no drawn border.
      backgroundColor: c.bgStep,
      padding: Math.round(14 * scale),
      borderRadius: 16,
      marginVertical: Math.round(blockGap * scale),
      fontFamily: FONT_MONO,
      fontSize: Math.round(12.5 * scale),
      color: c.text,
      ...(Platform.OS === "web" ? { boxShadow: c.liftSm } : {}),
    },
    ul: {
      marginTop: 0,
      marginBottom: Math.round(blockGap * scale),
      paddingLeft: Math.round((prose ? 20 : 24) * scale),
    },
    ol: {
      marginTop: 0,
      marginBottom: Math.round(blockGap * scale),
      paddingLeft: Math.round((prose ? 28 : 24) * scale),
    },
    li: {
      marginTop: 0,
      marginBottom: Math.round((prose ? 8 : 4) * scale),
      ...(prose
        ? { fontFamily: FONT_SANS, fontSize: 16, lineHeight: 24, color: c.text2, letterSpacing: 0 }
        : {}),
    },
    a: {
      color: c.accent,
      textDecorationLine: "none" as const,
    },
    blockquote: prose
      ? {
          // `.prose blockquote`: a card with a 3px gradient bar at the left
          // (web draws the bar in the custom renderer below).
          backgroundColor: c.bgStep,
          borderWidth: 1,
          borderColor: c.border,
          borderLeftWidth: Platform.OS === "web" ? 1 : 3,
          borderLeftColor: Platform.OS === "web" ? c.border : c.accent,
          borderRadius: 16,
          marginVertical: Math.round(blockGap * scale),
          marginLeft: 0,
          marginRight: 0,
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 22,
          paddingRight: 20,
          fontFamily: FONT_SANS,
          fontSize: 15,
          lineHeight: 23,
          letterSpacing: 0,
          color: c.text2,
        }
      : {
          borderLeftWidth: 3,
          borderLeftColor: c.borderStrong,
          marginVertical: Math.round(8 * scale),
          paddingLeft: Math.round(12 * scale),
          color: c.text2,
        },
    h1: {
      marginTop: Math.round((prose ? 26 : 16) * scale),
      marginBottom: Math.round(blockGap * scale),
      fontWeight: "400" as const,
      fontFamily: prose ? FONT_SERIF : bodyFont,
      color: color ?? c.text,
      fontSize: Math.round((prose ? 28 : 22) * scale),
      lineHeight: Math.round((prose ? 32 : 28) * scale),
      letterSpacing: 0,
    },
    h2: {
      marginTop: Math.round((prose ? 26 : 16) * scale),
      marginBottom: Math.round(blockGap * scale),
      fontWeight: "400" as const,
      fontFamily: prose ? FONT_SERIF : bodyFont,
      color: color ?? c.text,
      fontSize: Math.round((prose ? 24 : 19) * scale),
      lineHeight: Math.round((prose ? 28 : 25) * scale),
      letterSpacing: 0,
    },
    h3: {
      marginTop: Math.round((prose ? 26 : 16) * scale),
      marginBottom: Math.round(blockGap * scale),
      fontWeight: "400" as const,
      fontFamily: prose ? FONT_SERIF : bodyFont,
      color: color ?? c.text,
      fontSize: Math.round((prose ? 22 : 17) * scale),
      lineHeight: Math.round((prose ? 26 : 23) * scale),
      letterSpacing: prose ? 0.22 : 0,
    },
    // `.prose h4`: the xs caps accent eyebrow.
    h4: prose
      ? {
          marginTop: 22,
          marginBottom: Math.round(blockGap * scale),
          fontWeight: "400" as const,
          fontFamily: FONT_SANS,
          fontSize: 10,
          lineHeight: 12,
          letterSpacing: 1.8,
          textTransform: "uppercase" as const,
          color: c.accent,
        }
      : {
          marginTop: Math.round(12 * scale),
          marginBottom: Math.round(6 * scale),
          fontWeight: "400" as const,
          color: color ?? c.text,
        },
    hr: {
      height: 1,
      backgroundColor: c.border,
      borderWidth: 0,
      marginVertical: Math.round(blockGap * scale),
    },
    img: {
      borderRadius: 12,
    },
    // Table styles for web platform — a card on the sheet.
    table: {
      backgroundColor: c.bgStep,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      marginVertical: Math.round(blockGap * scale),
      overflow: "hidden" as const,
      ...(prose ? { fontFamily: FONT_SANS, fontSize: 14, lineHeight: 20, letterSpacing: 0 } : {}),
    },
    th: {
      backgroundColor: c.nest,
      padding: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.borderStrong,
      fontWeight: "400" as const,
      color: c.text,
    },
    td: {
      padding: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    tr: {
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
  }
}

/** List markers (`.prose ul li:before` / `.prose ol li:before`). */
function buildListProps(c: ReturnType<typeof useColors>, variant: MarkdownVariant) {
  if (variant !== "prose") return {}
  return {
    ul: {
      markerTextStyle: { color: c.accent },
      markerBoxStyle: { paddingRight: 8 },
    },
    ol: {
      markerTextStyle: { color: c.accent, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 20 },
      markerBoxStyle: {
        backgroundColor: c.navActive,
        borderRadius: 6,
        minWidth: 20,
        height: 20,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        marginRight: 8,
        marginTop: 2,
        paddingHorizontal: 4,
      },
    },
  }
}

// Custom renderer for <pre> blocks on web - enables horizontal scroll
export const PreRenderer = ({ tnode }: any) => {
  const c = useColors()
  // Extract text content from the DOM tree recursively
  const extractText = (node: any): string => {
    if (!node) return ""
    if (node.type === "text") return node.data || ""
    if (node.children) {
      return node.children.map(extractText).join("")
    }
    return ""
  }

  const textContent = extractText(tnode.domNode)

  return (
    // Wrapper carries the cloud (the pre clips for horizontal scroll).
    <div data-fx="cloud" style={{ position: "relative", marginTop: 8, marginBottom: 8 }}>
      <div
        style={{
          // `.prose .md-pre`: a card on the sheet — one step off, violet lift.
          backgroundColor: c.bgStep,
          padding: "14px 16px",
          borderRadius: 16,
          overflowX: "auto",
          whiteSpace: "pre",
          boxShadow: c.liftSm,
        }}
      >
        <code
          style={{
            fontFamily: FONT_MONO,
            fontSize: 12.5,
            lineHeight: "18px",
            color: c.text,
            whiteSpace: "pre",
            wordWrap: "normal",
            overflowWrap: "normal",
          }}
        >
          {textContent}
        </code>
      </div>
    </div>
  )
}

// `.prose blockquote:before` — the 3px gradient bar at the left of the card
// (web only; native draws a solid accent border via tagsStyles).
const BlockquoteRenderer = ({ TDefaultRenderer, ...props }: any) => (
  <div style={{ position: "relative" }}>
    <TDefaultRenderer {...props} />
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        top: 16,
        bottom: 16,
        width: 3,
        borderRadius: "0 3px 3px 0",
        background: GRAD_MONO,
        pointerEvents: "none",
      }}
    />
  </div>
)

// Web: a table is a box that asks for a look — the violet cloud blooms
// behind it (prototype `.approval` / `.tasks` recipe, `[data-fx~="cloud"]`).
const TableCloudRenderer = ({ TDefaultRenderer, ...props }: any) => (
  <div data-fx="cloud" style={{ position: "relative", width: "100%" }}>
    <TDefaultRenderer {...props} />
  </div>
)

// Custom renderers - use PreRenderer on web for horizontal scroll
const renderers: any =
  Platform.OS === "web"
    ? { pre: PreRenderer, blockquote: BlockquoteRenderer, table: TableCloudRenderer }
    : { table: TableRenderer }

// Type-in renderers built ONCE (stable identity — see renderersMemo).
const TYPEIN_RENDERERS = buildTypeInRenderers()

// Custom HTML element models for native platforms
const customHTMLElementModels: any =
  Platform.OS !== "web"
    ? {
        table: tableModel,
      }
    : {}

// Table configuration for WebView rendering on native — theme-adaptive
function buildTableConfig(c: ReturnType<typeof useColors>, isDarkMode = false) {
  return {
    WebView,
    webViewProps: {
      style: {
        backgroundColor: "transparent",
      },
    },
    tableStyleSpecs: {
      outerContainerStyle: {
        borderRadius: 8,
        overflow: "hidden" as const,
        marginVertical: 8,
      },
    },
    cssRules: `
      table {
        width: 100%;
        border-collapse: collapse;
        background-color: ${c.bgStep};
        box-shadow: ${isDarkMode ? "none" : c.liftSm};
        border-radius: 8px;
        overflow: hidden;
      }
      th {
        background-color: ${c.nest};
        padding: 10px 12px;
        text-align: left;
        font-weight: 400;
        color: ${c.text};
        border-bottom: 1px solid ${c.borderStrong};
        font-size: 14px;
      }
      td {
        padding: 10px 12px;
        color: ${c.text};
        border-bottom: 1px solid ${c.border};
        font-size: 14px;
      }
      tr:last-child td {
        border-bottom: none;
      }
      tr:nth-child(even) {
        background-color: ${c.nest};
      }
    `,
  }
}

// Render props for native platforms — built per-render with theme tokens
// (tableConfig needs useColors() tokens, so it's constructed in the component)

/**
 * Parse markdown once per source string (single-entry cache): the streaming
 * text block needs the HTML to measure the rendered text for the reveal
 * count, and MarkdownContent needs the same HTML to render — same string,
 * same render, one parse.
 */
let lastSource: string | null = null
let lastHtml = ""
export function parseMarkdown(source: string): string {
  if (source !== lastSource) {
    lastSource = source
    lastHtml = marked.parse(source) as string
  }
  return lastHtml
}

/** Reveal-over-rendered state (see typeInReveal.ts / StreamingProse). */
export interface MarkdownReveal {
  /** Rendered chars shown so far; the rest of the document is cut. */
  end: number
  /** Where the in-flight tail starts (chars from here enter blurred), or null. */
  boundary: number | null
  /** Keep the text past `end` and paint it muted instead of cutting it (interrupted voice reply). */
  unheard?: boolean
}

/**
 * Render markdown content as HTML using react-native-render-html
 *
 * `reveal` (type-in, DS Motion — reveal over rendered text): `text` is the
 * FULL source parsed ahead; `reveal.end` is how many rendered chars are
 * shown, `reveal.boundary` where the in-flight tail starts. The HTML is cut
 * at `end` (no element appears before its text does) and the runs crossing
 * the boundary are tagged for the per-char type-in spans (TypeIn.tsx). With
 * no `reveal` this renders plain.
 */
export function MarkdownContent({
  text,
  compact = false,
  reveal,
  variant = "plain",
  color,
}: {
  text: string
  compact?: boolean
  reveal?: MarkdownReveal | null
  /** Visual role: agent `prose`, user `bubble`, or the plain tool-renderer look. */
  variant?: MarkdownVariant
  /** Body colour override (the user bubble reads Main/800 on the mint glow). */
  color?: string
}) {
  const c = useColors()
  const { width } = useWindowDimensions()

  const end = reveal?.end
  const boundary = reveal?.boundary ?? null
  const unheard = reveal?.unheard === true
  const html = useMemo(() => {
    const full = parseMarkdown(text)
    if (end == null) return full
    return revealHtml(full, boundary, end, { unheard })
  }, [text, end, boundary, unheard])

  const isDark = c.bgPage === surface.dark.bgPage
  const tagsStylesMemo = useMemo(
    () => buildTagsStyles(c, compact, isDark, variant, color),
    [c, compact, isDark, variant, color],
  )

  const renderersPropsMemo = useMemo(
    () => ({
      ...(Platform.OS !== "web" ? { table: buildTableConfig(c, isDark) } : {}),
      ...buildListProps(c, variant),
    }),
    [c, isDark, variant],
  )

  // Type-in renderers merge with the platform ones (pre on web, table on
  // native) — with a STABLE identity (module-level, built ONCE).
  //
  // ⚠️ The identity is the whole game: rebuilding the map per tick (deps
  // [tailBoundary]) gave the span renderer a NEW function identity every
  // 25ms → TNodeRenderer saw a different component type → React remounted
  // the whole subtree → every span's animation restarted invisible (fill:
  // both) → 'reloads and starts over' after the first ~20 chars (the
  // round-4 remount, measured in the PoC: survived=0 at the first fold).
  // The renderers are no-ops without the tail marker in the subtree, so
  // one constant map is safe for every other MarkdownContent use (tool
  // renderers, user bubbles) that never passes a boundary.
  const renderersMemo = useMemo(() => ({ ...renderers, ...TYPEIN_RENDERERS }), [])

  return (
    <>
      {Platform.OS === "web" && reveal != null && <style>{TYPEIN_CSS}</style>}
      <RenderHtml
        systemFonts={BRAND_FONTS}
        contentWidth={width * 0.85}
        source={{ html }}
        tagsStyles={tagsStylesMemo}
        defaultTextProps={{ selectable: true }}
        renderers={renderersMemo}
        customHTMLElementModels={customHTMLElementModels}
        renderersProps={renderersPropsMemo}
      />
    </>
  )
}
