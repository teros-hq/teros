/**
 * GateHandle — Flowing-style triangular handle for React Flow nodes
 *
 * Replicates the exact visual design from Flowing/HexaFlows:
 * - SVG triangle (play-button shape) with colored fill + darker stroke border
 * - ALL triangles point RIGHT (direction='right', 0deg rotation) — same as Flowing
 * - Phosphor glyph centered inside the triangle
 * - Handle positioned via translate transform (same as Flowing's getTransform)
 *
 * **Data gates** (schemaId !== null): colored triangle + Package icon
 * **Signal-only gates** (schemaId === null): gray triangle + Bell icon
 *
 * Color system (Flowing-style):
 *   Fill   = lightenColor(artifact.color, 0.35)  ≈ shade-300
 *   Stroke = darkenColor(artifact.color, 0.35)   ≈ shade-600
 *   Signal = slate-300 fill, slate-600 stroke
 */

import { memo } from "react"
import { Handle, Position } from "@xyflow/react"
import { Ph } from "../../components/ui/ds"
import type { Artifact } from "@teros/workflows"
import { resolveGateColors } from "./flowingColors"

// ============================================================================
// TYPES
// ============================================================================

interface GateHandleProps {
  gateId: string
  type: "source" | "target"
  position: Position
  top: number
  schemaId: string | null
  artifact?: Artifact | null
}

// ============================================================================
// TRIANGLE SVG — Flowing's play-button triangle (always points right)
// ============================================================================

function TriangleSvg({ fillColor, strokeColor }: { fillColor: string; strokeColor: string }) {
  // Exact same path and sizing as Flowing's TriangleSvg
  return (
    <svg
      width="9"
      height="11"
      viewBox="0 0 9 11"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "40px",
        height: "40px",
        marginTop: "-4px",
        marginLeft: "-3px",
        pointerEvents: "none",
      }}
    >
      <path
        d="M7.75 6.79904L3.25 9.39712C2.25 9.97446 1 9.25278 1 8.09808L1 2.90192C1 1.74722 2.25 1.02554 3.25 1.60289L7.75 4.20096C8.75 4.77831 8.75 6.22169 7.75 6.79904Z"
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth="0.6"
      />
    </svg>
  )
}

// ============================================================================
// COMPONENT
// ============================================================================

function GateHandleInner({ gateId, type, position, top, schemaId, artifact }: GateHandleProps) {
  const isData = schemaId !== null

  // Resolve colors from artifact — same for both input and output (Flowing-style)
  const { fill: fillColor, stroke: strokeColor } = resolveGateColors(artifact?.color)

  // Choose the Phosphor glyph to render inside the triangle
  const iconName = isData ? "package" : "bell"

  // Transform to position the handle on the node edge horizontally.
  const getTransform = (): string => {
    if (position === Position.Left) return "translate(-50%, 0)"
    if (position === Position.Right) return "translate(50%, 0)"
    return "translate(0, 0)"
  }

  return (
    <Handle
      id={gateId}
      type={type}
      position={position}
      style={{
        top,
        transform: getTransform(),
        width: 32,
        height: 32,
        background: "transparent",
        border: "none",
        position: "absolute",
        zIndex: 10,
      }}
    >
      {/* Inner container — same as Flowing's div with p-2 */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 32,
          height: 32,
          padding: 8,
          pointerEvents: "none",
        }}
      >
        {/* Arrow container — 32px flex centered */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 32,
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          {/* Triangle SVG — always points right, same margins as Flowing */}
          <TriangleSvg fillColor={fillColor} strokeColor={strokeColor} />

          {/* Phosphor glyph centered inside the triangle */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: 32,
              height: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              transform: "translate(-0.5px, -0.5px)",
            }}
          >
            <Ph name={iconName} size={13} color={strokeColor} />
          </div>
        </div>
      </div>
    </Handle>
  )
}

export const GateHandle = memo(GateHandleInner)
