import type { ComponentType, ReactNode } from "react"
import { View } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { Card } from "../ui/ds/Card"
import { Ph } from "../ui/ds/Icon"
import { T } from "../ui/ds/Text"

/** An icon slot: a Phosphor name (preferred) or a legacy icon component. */
type IconSlot = string | ComponentType<{ size?: number; color?: string }>

function Glyph({ icon, size, color }: { icon?: IconSlot; size: number; color: string }) {
  if (!icon) return null
  if (typeof icon === "string") return <Ph name={icon} size={size} color={color} />
  const Cmp = icon
  return <Cmp size={size} color={color} />
}

/**
 * KPI tile — the OS prototype's `Stat` card: label (sm · text2), a big serif
 * figure, then unit / delta / sparkline / sub. The status variant paints the
 * figure in the status colour next to its icon.
 */
export function KpiTile({
  icon,
  label,
  value,
  unit,
  delta,
  deltaColor,
  sub,
  valueColor,
  statusColor,
  statusIcon,
  sparkline,
}: {
  icon?: IconSlot
  label: string
  value: string
  unit?: string
  delta?: string
  deltaColor?: string
  sub?: string
  valueColor?: string
  statusColor?: string
  statusIcon?: IconSlot
  sparkline?: ReactNode
}) {
  const c = useColors()
  return (
    <Card pad={20} style={{ minHeight: 100, flex: 1, minWidth: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Glyph icon={icon} size={13} color={c.text3} />
        <T step="sm" tone="text2" ellipsis style={{ flexShrink: 1 }}>
          {label}
        </T>
      </View>
      {statusColor ? (
        <>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              marginTop: 10,
              marginBottom: 6,
            }}
          >
            <Glyph icon={statusIcon} size={18} color={statusColor} />
            <T
              step="2xl"
              color={statusColor}
              numberOfLines={1}
              style={{ fontSize: 28, lineHeight: 32 }}
            >
              {value}
            </T>
          </View>
          {sub ? (
            <T step="sm" tone="text3" ellipsis>
              {sub}
            </T>
          ) : null}
        </>
      ) : (
        <>
          <View
            style={{
              flexDirection: "row",
              alignItems: "baseline",
              gap: 6,
              marginTop: 10,
              marginBottom: 6,
            }}
          >
            <T step="2xl" color={valueColor ?? c.text} numberOfLines={1} style={{ flexShrink: 1 }}>
              {value}
            </T>
            {unit ? (
              <T step="sm" tone="text3">
                {unit}
              </T>
            ) : null}
          </View>
          {delta || sparkline ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <T step="codenote" color={deltaColor ?? c.text3} numberOfLines={1}>
                {delta ?? ""}
              </T>
              {sparkline ? (
                <View style={{ flex: 1, maxWidth: 120, height: 30, minWidth: 0 }}>{sparkline}</View>
              ) : null}
            </View>
          ) : null}
          {sub ? (
            <T step="sm" tone="text3" ellipsis>
              {sub}
            </T>
          ) : null}
        </>
      )}
    </Card>
  )
}

/**
 * Row of KPI tiles — the prototype's `Stats` grid: cards on the sheet with a
 * 10px gap, wrapping to fewer columns on narrow panes.
 */
export function KpiStrip({ children }: { children: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", margin: -5 }}>
      {Array.isArray(children)
        ? children.filter(Boolean).map((child, i) => (
            <View
              key={i}
              style={{
                flexGrow: 1,
                flexBasis: 160,
                minWidth: 160,
                padding: 5,
                flexDirection: "row",
              }}
            >
              {child}
            </View>
          ))
        : children}
    </View>
  )
}

/** A section card: `T base` title + optional right slot over the content (the prototype's chart/list cards). */
export function SectionCard({
  title,
  right,
  children,
}: {
  title: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <Card pad>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <T step="base">{title}</T>
        {right}
      </View>
      {children}
    </Card>
  )
}
