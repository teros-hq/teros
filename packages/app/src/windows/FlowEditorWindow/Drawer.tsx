/**
 * Drawer — Reusable overlay drawer for mobile/responsive layouts
 *
 * Slides in from the left or right side of its positioned parent.
 * Uses absolute positioning relative to the nearest positioned ancestor
 * (the FlowEditorWindowContent container has position: relative).
 *
 * Features:
 * - Semi-transparent backdrop (click to close)
 * - Smooth slide-in/slide-out via CSS transform transition
 * - Optional header with title and close button
 * - Always mounted for transition continuity (translated off-screen when closed)
 * - Sheet-coloured panel with the raised lift (OS design language)
 */

import type { ReactNode } from "react"
import { IconBtn, T } from "../../components/ui/ds"
import { useFlowEditorTheme } from "./useFlowEditorTheme"

interface DrawerProps {
  /** Which side the drawer slides in from */
  side: "left" | "right"
  /** Whether the drawer is currently open */
  open: boolean
  /** Called when the drawer requests to close (backdrop click or X button) */
  onClose: () => void
  /** Optional header title shown above the content */
  title?: string
  /** Drawer width in pixels (default 280) */
  width?: number
  /** Content to render inside the drawer */
  children: ReactNode
}

export function Drawer({ side, open, onClose, title, width = 280, children }: DrawerProps) {
  const t = useFlowEditorTheme()
  const isLeft = side === "left"

  return (
    <>
      {/* Backdrop — always rendered, opacity + pointer-events toggled */}
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: t.drawerOverlay,
          zIndex: 999,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Drawer panel — always rendered, translated off-screen when closed */}
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: isLeft ? 0 : undefined,
          right: isLeft ? undefined : 0,
          width,
          background: t.drawerBg,
          borderRight: isLeft ? `1px solid ${t.drawerBorder}` : undefined,
          borderLeft: !isLeft ? `1px solid ${t.drawerBorder}` : undefined,
          zIndex: 1000,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          transform: open ? "translateX(0)" : `translateX(${isLeft ? "-100%" : "100%"})`,
          transition: "transform 0.35s cubic-bezier(.16,1,.3,1)",
          fontFamily: t.fontSans,
          boxShadow: open ? t.drawerShadow : "none",
        }}
      >
        {/* Header with title and close button */}
        {title && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 12px 10px 16px",
              borderBottom: `1px solid ${t.drawerBorder}`,
              flexShrink: 0,
            }}
          >
            <span
              style={{ width: 5, height: 5, borderRadius: 3, background: t.accent, flexShrink: 0 }}
            />
            <T step="xs" tone="text2" style={{ flex: 1 }}>
              {title}
            </T>
            <IconBtn icon="x" plain sm onPress={onClose} title="Close" />
          </div>
        )}

        {/* Content */}
        <div
          style={{
            flex: 1,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {children}
        </div>
      </div>
    </>
  )
}
