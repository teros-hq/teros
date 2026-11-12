/**
 * Ph — Phosphor icon (web). Draws the glyph with the Phosphor web font that
 * `app/+html.tsx` already loads (regular, bold and fill), exactly like the OS
 * prototype (`<i class="ph ph-name">`). Native resolves `./Icon.tsx`.
 */
import React from "react"
import type { PhProps } from "./Icon.types"

export function Ph({
  name,
  size = 16,
  color = "currentColor",
  weight = "regular",
  style,
}: PhProps) {
  const cls = weight === "bold" ? "ph-bold" : weight === "fill" ? "ph-fill" : "ph"
  return (
    <i
      className={`${cls} ph-${name}`}
      aria-hidden
      style={{
        fontSize: size,
        color,
        lineHeight: 1,
        display: "inline-block",
        flexShrink: 0,
        width: size,
        height: size,
        textAlign: "center",
        ...(style as object),
      }}
    />
  )
}
