/**
 * RenderHtml custom renderers + props of the unified markdown renderer
 * (MD-UNIFY v2, step 4 — moved verbatim from chat/bubbles/MarkdownContent so
 * every surface that renders through RenderHtml shares one set).
 *
 * Web  : <pre> with horizontal scroll (PreRenderer), the violet cloud behind
 *        tables, and — prose only — the 3px gradient bar on blockquotes.
 * Native: the table plugin (WebView table) — required lazily so web bundles
 *        never pull react-native-webview.
 *
 * Every map is built ONCE at module level (stable identity — the Fase-1
 * remount lesson: a per-render renderers map remounts the subtree).
 */
import React from "react"
import { Platform } from "react-native"

import { FONT_MONO } from "../mca/primitives/fonts"
import { useColors } from "../mca/primitives/useColors"
import { buildTypeInRenderers } from "../chat/bubbles/TypeIn"

const GRAD_MONO = "linear-gradient(135deg, #6F27FF 0%, #9C6BFF 100%)"

type Colors = ReturnType<typeof useColors>

// Custom renderer for <pre> blocks on web - enables horizontal scroll
export const PreRenderer = ({ tnode }: any) => {
  const c = useColors()
  const extractText = (node: any): string => {
    if (!node) return ""
    if (node.type === "text") return node.data || ""
    if (node.children) return node.children.map(extractText).join("")
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

// `.prose blockquote:before` — the 3px gradient bar at the left of the card.
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

// Web: a table is a box that asks for a look — the violet cloud blooms behind it.
const TableCloudRenderer = ({ TDefaultRenderer, ...props }: any) => (
  <div data-fx="cloud" style={{ position: "relative", width: "100%" }}>
    <TDefaultRenderer {...props} />
  </div>
)

const nativeTable: { TableRenderer: any; tableModel: any; WebView: any } | null =
  Platform.OS === "web"
    ? null
    : (() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const plugin = require("@native-html/table-plugin")
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const WebView = require("react-native-webview").default ?? require("react-native-webview")
        return { TableRenderer: plugin.default, tableModel: plugin.tableModel, WebView }
      })()

const TYPEIN = buildTypeInRenderers()

const WEB = { pre: PreRenderer, table: TableCloudRenderer }
const NATIVE = nativeTable ? { table: nativeTable.TableRenderer } : {}

/** Renderer maps — module-level constants, picked by (prose?) only. */
export const RENDERERS: { prose: any; other: any } = {
  prose: { ...(Platform.OS === "web" ? { ...WEB, blockquote: BlockquoteRenderer } : NATIVE), ...TYPEIN },
  other: { ...(Platform.OS === "web" ? WEB : NATIVE), ...TYPEIN },
}

export const ELEMENT_MODELS: any = nativeTable ? { table: nativeTable.tableModel } : {}

/** Native table WebView config — theme-adaptive. */
function buildTableConfig(c: Colors, isDark: boolean) {
  return {
    WebView: nativeTable?.WebView,
    webViewProps: { style: { backgroundColor: "transparent" } },
    tableStyleSpecs: {
      outerContainerStyle: { borderRadius: 8, overflow: "hidden" as const, marginVertical: 8 },
    },
    cssRules: `
      table { width: 100%; border-collapse: collapse; background-color: ${c.bgStep};
        box-shadow: ${isDark ? "none" : c.liftSm}; border-radius: 8px; overflow: hidden; }
      th { background-color: ${c.nest}; padding: 10px 12px; text-align: left; font-weight: 400;
        color: ${c.text}; border-bottom: 1px solid ${c.borderStrong}; font-size: 14px; }
      td { padding: 10px 12px; color: ${c.text}; border-bottom: 1px solid ${c.border}; font-size: 14px; }
      tr:last-child td { border-bottom: none; }
      tr:nth-child(even) { background-color: ${c.nest}; }
    `,
  }
}

/** List markers (`.prose ul li:before` / `.prose ol li:before`) + native table config. */
export function buildRenderersProps(c: Colors, isDark: boolean, prose: boolean) {
  return {
    ...(Platform.OS !== "web" ? { table: buildTableConfig(c, isDark) } : {}),
    ...(prose
      ? {
          ul: { markerTextStyle: { color: c.accent }, markerBoxStyle: { paddingRight: 8 } },
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
      : {}),
  }
}
