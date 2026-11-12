/**
 * ImagePlaceholder
 *
 * Shown in place of any image node in the rendered Markdown.
 * - External images (http:// / https://) are always blocked (security constraint).
 * - Local workspace images are also shown as placeholders in v1.
 *
 * Displays the alt text and the blocked URL so the user knows what was there.
 * Look: a dashed violet-tinted box (the design system's `i` tint).
 */

import React from "react"
import { Platform, View } from "react-native"
import { useColors } from "../../../components/mca/primitives/useColors"
import { FONT_MONO, FONT_SERIF } from "../../../components/mca/primitives/fonts"
import { Ph, T } from "../../../components/ui/ds"

interface ImagePlaceholderProps {
  /** Alt text from the Markdown image syntax */
  alt?: string
  /** The src URL that was blocked */
  url?: string
  /** True when the image is a local workspace path (not external) */
  local?: boolean
}

export function ImagePlaceholder({ alt, url, local = false }: ImagePlaceholderProps) {
  const c = useColors()
  const label = local ? "Local image (not loaded in v1)" : "External image blocked"

  if (Platform.OS === "web") {
    return (
      <div
        style={{
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 4,
          padding: "10px 14px",
          margin: "4px 0",
          border: `1px dashed ${c.tint.i.bd}`,
          borderRadius: 12,
          backgroundColor: c.tint.i.bg,
          maxWidth: "100%",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: c.tint.i.tx,
            fontSize: 12,
          }}
        >
          <Ph name="image" size={14} color={c.tint.i.tx} />
          <span>{label}</span>
        </div>
        {alt && (
          <span
            style={{ fontSize: 13, color: c.text2, fontFamily: `'${FONT_SERIF}', Georgia, serif` }}
          >
            {alt}
          </span>
        )}
        {url && (
          <span
            style={{
              fontSize: 11,
              color: c.text3,
              fontFamily: `'${FONT_MONO}', 'JetBrains Mono', 'Fira Code', monospace`,
              wordBreak: "break-all",
            }}
          >
            {url}
          </span>
        )}
      </div>
    )
  }

  // Native fallback
  return (
    <View
      style={{
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: c.tint.i.bd,
        borderRadius: 12,
        backgroundColor: c.tint.i.bg,
        padding: 12,
        marginVertical: 4,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Ph name="image" size={14} color={c.tint.i.tx} />
        <T step="12" color={c.tint.i.tx}>
          {label}
        </T>
      </View>
      {alt ? (
        <T step="bserif" tone="text2">
          {alt}
        </T>
      ) : null}
      {url ? (
        <T step="code" tone="text3">
          {url}
        </T>
      ) : null}
    </View>
  )
}
