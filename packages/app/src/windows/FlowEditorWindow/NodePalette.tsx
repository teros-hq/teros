/**
 * NodePalette — Sidebar with draggable node types
 *
 * Users drag node types from this palette onto the React Flow canvas
 * to create new nodes. Each item shows the node type icon, label,
 * and description.
 *
 * Supports two rendering variants:
 * - 'inline' (default): renders as a fixed-width sidebar (desktop)
 * - 'drawer': renders as the body content inside a Drawer overlay (mobile)
 *
 * Presentation follows the OS design language: a sheet-coloured panel, an
 * `xs` caps section header and one `LRow hov`-style row per node type (a
 * `Tile sm` with the Phosphor glyph + name + description). The rows stay
 * plain `<div draggable>` because the HTML5 drag API has to reach the
 * React Flow canvas.
 */

import { useTranslation } from "react-i18next"
import { Ph, T, Tile } from "../../components/ui/ds"
import { NODE_PALETTE, NODE_TYPE_META, type NodeType } from "./types"
import { useFlowEditorTheme } from "./useFlowEditorTheme"

interface NodePaletteProps {
  /** Called when a node type is selected (for click-to-add) */
  onAddNode?: (type: NodeType) => void
  /** Rendering variant: 'inline' = fixed sidebar, 'drawer' = drawer body */
  variant?: "inline" | "drawer"
}

export function NodePalette({ onAddNode, variant = "inline" }: NodePaletteProps) {
  const t = useFlowEditorTheme()
  const { t: tr } = useTranslation()
  // In drawer mode, we omit the outer border and fixed width — the Drawer provides those.
  // The header and footer are also omitted in drawer mode since the Drawer has its own header.
  const isDrawer = variant === "drawer"

  return (
    <div
      style={{
        width: isDrawer ? "100%" : 220,
        minWidth: isDrawer ? undefined : 220,
        flex: isDrawer ? 1 : undefined,
        background: t.sidebarBg,
        borderRight: isDrawer ? undefined : `1px solid ${t.sidebarBorder}`,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: t.fontSans,
      }}
    >
      {!isDrawer && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "14px 16px 10px",
          }}
        >
          <span
            style={{ width: 5, height: 5, borderRadius: 3, background: t.accent, flexShrink: 0 }}
          />
          <T step="xs" tone="text2">
            {tr("flowEditor.palette.title", { defaultValue: "Node types" })}
          </T>
          <span
            style={{ flex: 1, height: 1, background: t.sidebarBorder, opacity: 0.7, marginLeft: 4 }}
          />
        </div>
      )}

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: isDrawer ? 12 : "0 12px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {NODE_PALETTE.map((nodeType) => {
          const meta = NODE_TYPE_META[nodeType]
          return (
            <div
              key={nodeType}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/teros-flow-node", nodeType)
                e.dataTransfer.effectAllowed = "move"
              }}
              onClick={() => onAddNode?.(nodeType)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 12px",
                background: t.cardBg,
                borderRadius: 12,
                cursor: "grab",
                border: "1px solid transparent",
                boxShadow: t.liftSm,
                transition:
                  "box-shadow 0.35s cubic-bezier(.16,1,.3,1), transform 0.3s cubic-bezier(.16,1,.3,1)",
                userSelect: "none",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = t.liftSmHover
                e.currentTarget.style.transform = "translateY(-1px)"
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = t.liftSm
                e.currentTarget.style.transform = "translateY(0)"
              }}
            >
              <Tile sm icon={meta.phIcon} />
              <div
                style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}
              >
                <T step="sm" ellipsis>
                  {meta.label}
                </T>
                <T step="12" tone="text3" numberOfLines={2}>
                  {meta.description}
                </T>
              </div>
              <Ph name="dots-six-vertical" size={14} color={t.text3} />
            </div>
          )
        })}
      </div>

      {!isDrawer && (
        <div
          style={{
            padding: "10px 16px 14px",
            borderTop: `1px solid ${t.sidebarBorder}`,
          }}
        >
          <T step="12" tone="text3" center>
            {tr("flowEditor.palette.hint", {
              defaultValue: "Drag onto the canvas, or click to add",
            })}
          </T>
        </div>
      )}
    </div>
  )
}
