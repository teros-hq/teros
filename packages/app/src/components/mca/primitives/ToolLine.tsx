/**
 * ToolLine — the prototype's `tline`: how an executed (or running) tool call
 * sits inside an agent turn. Not a card: one row with the CallChip (app
 * glyph + descriptive label), optional markers, and a `{}` affordance;
 * tapping the row unfolds the detail (the renderer's body) underneath.
 */
import React, { useState } from "react"
import { Platform, Pressable, View } from "react-native"
import { T } from "../../ui/ds/Text"
import { Ph } from "../../ui/ds/Icon"
import { CallChip, type CallChipProps } from "./CallChip"
import { useColors } from "./useColors"

export interface ToolLineProps extends CallChipProps {
  /** Markers after the chip (badge / risk / irreversible). */
  trailing?: React.ReactNode
  /** The detail unfolded by `{}` — the renderer's body. */
  children?: React.ReactNode
  defaultExpanded?: boolean
}

export function ToolLine({ trailing, children, defaultExpanded = false, ...chip }: ToolLineProps) {
  const c = useColors()
  const [open, setOpen] = useState(defaultExpanded)
  const [hover, setHover] = useState(false)
  const web = Platform.OS === "web"
  const hasDetail = children != null && children !== false
  return (
    <View
      style={{ gap: 8, minWidth: 0, width: "100%" }}
      {...(web
        ? ({ onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) } as any)
        : {})}
    >
      {/* The whole row toggles the detail (touch has no hover for `{}`). */}
      <Pressable
        accessibilityRole={hasDetail ? "button" : undefined}
        accessibilityState={hasDetail ? { expanded: open } : undefined}
        disabled={!hasDetail}
        onPress={() => setOpen((v) => !v)}
        style={[
          { flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0 },
          web ? ({ cursor: hasDetail ? "pointer" : "default" } as any) : null,
        ]}
      >
        <View style={{ flexShrink: 1, minWidth: 0, maxWidth: "100%" }}>
          <CallChip {...chip} />
        </View>
        {trailing}
        <View style={{ flex: 1 }} />
        {hasDetail ? (
          // Affordance only — the row is the button. Fades in on hover.
          <View
            style={[
              {
                width: 26,
                height: 26,
                borderRadius: 8,
                alignItems: "center",
                justifyContent: "center",
                opacity: open ? 1 : hover ? 0.55 : web ? 0 : 0.55,
                backgroundColor: open ? c.wash : "transparent",
              },
              web ? ({ transition: "opacity .2s, background .2s" } as any) : null,
            ]}
          >
            <Ph name="brackets-curly" size={14} color={open ? c.text : c.text2} />
          </View>
        ) : null}
      </Pressable>
      {open && hasDetail ? (
        <View
          style={{
            borderRadius: 12,
            backgroundColor: c.nest,
            paddingHorizontal: 14,
            paddingVertical: 12,
            gap: 10,
          }}
        >
          {children}
        </View>
      ) : null}
    </View>
  )
}
