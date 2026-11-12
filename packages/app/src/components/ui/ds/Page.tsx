/**
 * Page scaffolding of the OS prototype (design-testing), compact density.
 *
 *   <Page>                               scroll, 24/32 padding, 1072 max width
 *     <PageHead eyebrow="APPS" title="Mis apps" lead="15 instaladas…" actions={…} />
 *     <SectionLabel label="Instaladas" count={10} dot />
 *     <Grid cols={3}>…</Grid>
 *   </Page>
 *
 * `PHead` is the sticky window header of chat/board (`.phead`): serif title +
 * tools on one 60px strip (transparent in the unida frame).
 */
import React from "react"
import {
  Platform,
  ScrollView,
  type ScrollViewProps,
  View,
  type ViewStyle,
  useWindowDimensions,
} from "react-native"
import { useColors } from "../../mca/primitives/useColors"
import { colors as semantic } from "../../mca/primitives/colors"
import { Ph } from "./Icon"
import { Headline, T } from "./Text"
import { fx } from "../../../styles/fx"

export interface PageProps extends ScrollViewProps {
  narrow?: boolean
  /** No max-width — e.g. a board that scrolls sideways. */
  fluid?: boolean
  /** Disable the scroll (the content scrolls itself). */
  noScroll?: boolean
  padTop?: number
  /** Ref to the underlying ScrollView (scrollTo, refresh control…). */
  scrollRef?: React.Ref<ScrollView>
  children?: React.ReactNode
  style?: ViewStyle
  innerStyle?: ViewStyle
}

export function usePagePadding() {
  const { width } = useWindowDimensions()
  return width <= 620
    ? { h: 16, t: 18, b: 36 }
    : width <= 980
      ? { h: 24, t: 22, b: 44 }
      : { h: 32, t: 24, b: 48 }
}

export function Page({
  narrow,
  fluid,
  noScroll,
  padTop,
  scrollRef,
  children,
  style,
  innerStyle,
  ...rest
}: PageProps) {
  const c = useColors()
  const p = usePagePadding()
  const inner = (
    <View
      {...fx("page")}
      style={[
        { width: "100%", alignSelf: "center" },
        fluid ? null : { maxWidth: narrow ? 760 : 1072 },
        innerStyle,
      ]}
    >
      {children}
    </View>
  )
  if (noScroll) {
    return (
      <View
        style={[
          {
            flex: 1,
            backgroundColor: c.bgSheet,
            paddingHorizontal: p.h,
            paddingTop: padTop ?? p.t,
          },
          style,
        ]}
      >
        {inner}
      </View>
    )
  }
  return (
    <ScrollView
      ref={scrollRef}
      {...rest}
      style={[{ flex: 1, backgroundColor: c.bgSheet }, style]}
      contentContainerStyle={{
        paddingHorizontal: p.h,
        paddingTop: padTop ?? p.t,
        paddingBottom: p.b,
      }}
      {...(Platform.OS === "web" ? ({ className: "chat-scroll" } as any) : {})}
    >
      {inner}
    </ScrollView>
  )
}

export interface PageHeadProps {
  /** Small uppercase label above the title (accent colour). */
  eyebrow?: string
  title: string
  /** Word of the title drawn in the accent (`Esperan tu <permiso.>`). */
  accent?: string
  lead?: string | React.ReactNode
  actions?: React.ReactNode
  /** A badge next to the eyebrow. */
  eyebrowRight?: React.ReactNode
  style?: ViewStyle
}

export function PageHead({
  eyebrow,
  title,
  accent,
  lead,
  actions,
  eyebrowRight,
  style,
}: PageHeadProps) {
  const { width } = useWindowDimensions()
  const column = width <= 620
  return (
    <View
      style={[
        {
          flexDirection: column ? "column" : "row",
          alignItems: column ? "flex-start" : "flex-end",
          justifyContent: "space-between",
          gap: 24,
          marginBottom: 20,
          flexWrap: "wrap",
        },
        style,
      ]}
    >
      <View style={{ flex: 1, minWidth: 240 }}>
        {eyebrow ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <T step="xs" tone="accent">
              {eyebrow}
            </T>
            {eyebrowRight}
          </View>
        ) : null}
        <Headline text={title} accent={accent} />
        {lead ? (
          typeof lead === "string" ? (
            <T step="lg" tone="text2" style={{ marginTop: 12, maxWidth: 560 }}>
              {lead}
            </T>
          ) : (
            <View style={{ marginTop: 12 }}>{lead}</View>
          )
        ) : null}
      </View>
      {actions ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {actions}
        </View>
      ) : null}
    </View>
  )
}

/** `.section-label` — dot + uppercase label + line + count. */
export function SectionLabel({
  label,
  count,
  dot = true,
  right,
  style,
}: {
  label: string
  count?: number | string
  dot?: boolean
  right?: React.ReactNode
  style?: ViewStyle
}) {
  const c = useColors()
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingBottom: 12,
          marginBottom: 16,
          marginTop: 8,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
        },
        style,
      ]}
    >
      {dot ? (
        <View
          style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: semantic.purple300 }}
        />
      ) : null}
      <T step="xs" tone="text2">
        {label}
      </T>
      <View style={{ flex: 1 }} />
      {right}
      {count != null ? (
        <T step="codenote" tone="text3">
          {String(count)}
        </T>
      ) : null}
    </View>
  )
}

/** `.sec-h` — the compact sidebar section header: label + hairline + actions. */
export function SecH({
  label,
  children,
  style,
}: {
  label: string
  children?: React.ReactNode
  style?: ViewStyle
}) {
  const c = useColors()
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          height: 24,
          paddingLeft: 12,
          paddingRight: 4,
          gap: 2,
        },
        style,
      ]}
    >
      <T step="xs" tone="text3">
        {label}
      </T>
      <View
        style={{
          flex: 1,
          height: 1,
          backgroundColor: c.border,
          opacity: 0.7,
          marginLeft: 8,
          marginRight: 6,
        }}
      />
      {children}
    </View>
  )
}

/** Responsive grid: 3 cols → 2 (≤1180/980 pane) → 1 (≤620). */
export function Grid({
  cols = 3,
  gap = 10,
  min = 240,
  children,
  style,
}: {
  cols?: number
  gap?: number
  min?: number
  children: React.ReactNode
  style?: ViewStyle
}) {
  const { width } = useWindowDimensions()
  const [w, setW] = React.useState(0)
  const avail = w || width
  const n = Math.max(1, Math.min(cols, Math.floor((avail + gap) / (min + gap))))
  const items = React.Children.toArray(children).filter(Boolean)
  return (
    <View
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      style={[{ flexDirection: "row", flexWrap: "wrap", marginHorizontal: -gap / 2 }, style]}
    >
      {items.map((child, i) => (
        <View
          key={i}
          style={{ width: `${100 / n}%`, paddingHorizontal: gap / 2, marginBottom: gap }}
        >
          {child}
        </View>
      ))}
    </View>
  )
}

export function EmptyHint({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return (
    <T
      step="12"
      tone="text3"
      style={[{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 4 }, style]}
    >
      {children}
    </T>
  )
}

/** Empty state block: icon tile + serif title + sub (`.empty`). */
export function EmptyState({
  icon,
  title,
  text,
  action,
  style,
}: {
  icon?: string
  title: string
  text?: string
  action?: React.ReactNode
  style?: ViewStyle
}) {
  const c = useColors()
  return (
    <View
      style={[
        {
          alignItems: "center",
          justifyContent: "center",
          paddingVertical: 48,
          paddingHorizontal: 24,
          gap: 10,
        },
        style,
      ]}
    >
      {icon ? (
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            backgroundColor: c.tile,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 6,
          }}
        >
          <Ph name={icon} size={22} color={c.accent} />
        </View>
      ) : null}
      <T step="xl" center>
        {title}
      </T>
      {text ? (
        <T step="sm" tone="text3" center style={{ maxWidth: 420 }}>
          {text}
        </T>
      ) : null}
      {action ? <View style={{ marginTop: 10 }}>{action}</View> : null}
    </View>
  )
}

/** `.phead` — the 60px window header strip: serif title + tools. */
export function PHead({
  icon,
  title,
  children,
  right,
  style,
}: {
  icon?: string
  title: React.ReactNode
  children?: React.ReactNode
  right?: React.ReactNode
  style?: ViewStyle
}) {
  const c = useColors()
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 14,
          minHeight: 60,
          paddingVertical: 12,
          paddingHorizontal: 20,
          flexWrap: "wrap",
          backgroundColor: c.bgSheet,
        },
        style,
      ]}
    >
      {icon ? (
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            backgroundColor: c.tile,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ph name={icon} size={22} color={c.accent} />
        </View>
      ) : null}
      {typeof title === "string" ? (
        <T step="xl" ellipsis style={{ flexShrink: 1 }}>
          {title}
        </T>
      ) : (
        title
      )}
      {children}
      <View style={{ flex: 1 }} />
      {right}
    </View>
  )
}
