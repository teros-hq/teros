/**
 * UI Test Window — Theme & Component Preview
 *
 * Shows all surface tokens, semantic colors, status tints and tab variations
 * in both light and dark modes for visual testing. Internal test bed —
 * laid out as a `Page` of `Card pad` sections.
 */

import React from "react"
import { Platform, View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors, surface } from "../../components/mca/primitives/colors"
import { Badge, Card, Page, PageHead, Ph, T } from "../../components/ui/ds"
import { ConcaveCorner, TAB_RADIUS } from "../../components/workspace/ConcaveCorner"

/** Composite semi-transparent rgba over opaque hex → opaque hex */
function compositeOver(rgba: string, bg: string): string {
  const m = rgba.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/)
  if (!m) return rgba
  const r = Number(m[1]),
    g = Number(m[2]),
    b = Number(m[3])
  const a = m[4] !== undefined ? Number(m[4]) : 1
  if (a >= 1) return rgba
  const bm = bg.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!bm) return rgba
  const br = parseInt(bm[1], 16),
    bg2 = parseInt(bm[2], 16),
    bb = parseInt(bm[3], 16)
  const rr = Math.round(r * a + br * (1 - a))
  const rg = Math.round(g * a + bg2 * (1 - a))
  const rb = Math.round(b * a + bb * (1 - a))
  return `#${rr.toString(16).padStart(2, "0")}${rg.toString(16).padStart(2, "0")}${rb.toString(16).padStart(2, "0")}`
}

interface Props {
  windowId: string
}

const MAX_TAB_WIDTH = 180
const MIN_TAB_WIDTH = 60

// ─── Tab preview (replicates TilingContainer tabs) ─────────────────────────
function TabPreview({
  label,
  isActive,
  isContainerActive = true,
  tabBarColor,
}: {
  label: string
  isActive: boolean
  isContainerActive?: boolean
  tabBarColor?: string
}) {
  const c = useColors()
  const resolvedTabBar = tabBarColor ?? c.bgFrame

  // Composite semi-transparent tokens over the tab bar for opaque colors
  const activeBg = compositeOver(c.bgStep, resolvedTabBar)
  const activeBorder = compositeOver(c.borderStrong, resolvedTabBar)
  const inactiveBg = compositeOver(c.wash2, resolvedTabBar)
  const inactiveHover = compositeOver(c.nestHover, resolvedTabBar)

  const TC = {
    active: {
      border: activeBorder,
      background: activeBg,
      tabText: c.text,
    },
    inactive: {
      border: compositeOver(c.border, resolvedTabBar),
      background: inactiveBg,
      tabText: c.text3,
    },
    inactiveTab: inactiveBg,
    inactiveTabText: c.text3,
    inactiveTabHover: inactiveHover,
    iconDim: c.text3,
  }

  const colors = isContainerActive ? TC.active : TC.inactive
  const [hover, setHover] = React.useState(false)
  const hoverProps =
    Platform.OS === "web"
      ? ({ onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) } as any)
      : {}

  if (isActive) {
    return (
      <View
        style={{
          flex: 1,
          maxWidth: MAX_TAB_WIDTH,
          minWidth: MIN_TAB_WIDTH,
          height: 32,
          paddingLeft: 10,
          paddingRight: 4,
          gap: 6,
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: colors.background,
          borderTopLeftRadius: TAB_RADIUS,
          borderTopRightRadius: TAB_RADIUS,
          borderWidth: 1,
          borderBottomWidth: 0,
          borderColor: colors.border,
          marginLeft: 4,
          marginRight: 4,
          position: "relative",
          top: 1,
          zIndex: 3,
        }}
      >
        <ConcaveCorner
          side="left"
          borderColor={colors.border}
          backgroundColor={colors.background}
        />
        <ConcaveCorner
          side="right"
          borderColor={colors.border}
          backgroundColor={colors.background}
        />
        <View
          style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent, flexShrink: 0 }}
        />
        <T step="12" color={colors.tabText} ellipsis style={{ flex: 1 }}>
          {label}
        </T>
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 4,
            justifyContent: "center",
            alignItems: "center",
            opacity: 0.5,
          }}
        >
          <Ph name="x-circle" size={12} color={TC.iconDim} />
        </View>
      </View>
    )
  }

  return (
    <View
      {...hoverProps}
      style={{
        flex: 1,
        maxWidth: MAX_TAB_WIDTH,
        minWidth: MIN_TAB_WIDTH,
        height: 32,
        paddingLeft: 10,
        paddingRight: 4,
        gap: 6,
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: hover ? TC.inactiveTabHover : TC.inactiveTab,
        borderTopLeftRadius: TAB_RADIUS,
        borderTopRightRadius: TAB_RADIUS,
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: c.accent,
          flexShrink: 0,
          opacity: 0.5,
        }}
      />
      <T step="12" color={TC.inactiveTabText} ellipsis style={{ flex: 1 }}>
        {label}
      </T>
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 4,
          justifyContent: "center",
          alignItems: "center",
          opacity: 0.3,
        }}
      >
        <Ph name="x-circle" size={12} color={TC.iconDim} />
      </View>
    </View>
  )
}

// ─── Tab bar preview ───────────────────────────────────────────────────────
function TabBarPreview({ tabBarColor }: { tabBarColor?: string }) {
  const c = useColors()
  const resolvedTabBar = tabBarColor ?? c.bgFrame

  const Row = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <View>
      <T step="xs" tone="text3" style={{ marginBottom: 6 }}>
        {title}
      </T>
      <View
        style={{
          height: 39,
          backgroundColor: resolvedTabBar,
          alignItems: "flex-end",
          flexDirection: "row",
          position: "relative",
          zIndex: 2,
          borderTopLeftRadius: 10,
          borderTopRightRadius: 10,
          paddingHorizontal: 6,
        }}
      >
        <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-end" }}>{children}</View>
      </View>
    </View>
  )

  return (
    <View style={{ gap: 14 }}>
      {/* Active container */}
      <View>
        <Row title="Active Container">
          <TabPreview label="Chat — Alice" isActive={true} />
          <TabPreview label="Apps" isActive={false} />
          <TabPreview label="Board" isActive={false} />
          <TabPreview label="Profile" isActive={false} />
        </Row>
        {/* Content area below tabs */}
        <View
          style={{
            backgroundColor: c.bgStep,
            borderWidth: 1,
            borderTopWidth: 0,
            borderColor: c.borderStrong,
            padding: 12,
            minHeight: 60,
            borderBottomLeftRadius: 10,
            borderBottomRightRadius: 10,
          }}
        >
          <T step="12" tone="text2">
            Content area (c.bgStep)
          </T>
        </View>
      </View>

      {/* Inactive container */}
      <Row title="Inactive Container">
        <TabPreview label="Chat — Nira" isActive={true} isContainerActive={false} />
        <TabPreview label="MCA Status" isActive={false} isContainerActive={false} />
        <TabPreview label="Files" isActive={false} isContainerActive={false} />
      </Row>

      {/* Single tab (min width scenario) */}
      <Row title="Single Tab">
        <TabPreview label="Only Window" isActive={true} />
      </Row>

      {/* Many tabs (overflow scenario) */}
      <Row title="Many Tabs (flex shrink)">
        <TabPreview label="Chat" isActive={true} />
        <TabPreview label="Apps" isActive={false} />
        <TabPreview label="Board" isActive={false} />
        <TabPreview label="Profile" isActive={false} />
        <TabPreview label="Providers" isActive={false} />
        <TabPreview label="Skills" isActive={false} />
        <TabPreview label="MCA" isActive={false} />
        <TabPreview label="Catalog" isActive={false} />
      </Row>
    </View>
  )
}

// ─── Token swatches ────────────────────────────────────────────────────────
function Swatch({ name, value }: { name: string; value: string }) {
  const c = useColors()
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        width: "50%",
        minWidth: 200,
        paddingVertical: 3,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          backgroundColor: value,
          borderWidth: 1,
          borderColor: c.borderStrong,
          flexShrink: 0,
        }}
      />
      <View style={{ flexShrink: 1 }}>
        <T step="sm">{name}</T>
        <T step="code" tone="text3" ellipsis>
          {value}
        </T>
      </View>
    </View>
  )
}

function SwatchGrid({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap" }}>{children}</View>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card pad style={{ marginBottom: 12 }}>
      <T step="base" style={{ marginBottom: 12 }}>
        {title}
      </T>
      {children}
    </Card>
  )
}

// ─── Main component ────────────────────────────────────────────────────────
export function UITestWindowContent({ windowId: _windowId }: Props) {
  const c = useColors()
  const isDark = c.bgPage === surface.dark.bgPage
  const mode = isDark ? "dark" : "light"

  return (
    <Page narrow>
      <PageHead
        eyebrow="INTERNO"
        title="UI Test — Theme Preview"
        lead={`Mode: ${mode} · Testing tabs, tokens & colors`}
        eyebrowRight={
          <Badge dashed cap>
            test bed
          </Badge>
        }
      />

      {/* ─── Tab previews ─── */}
      <Section title="Tab Bar">
        <TabBarPreview />
      </Section>

      {/* ─── Surface tokens ─── */}
      <Section title={`Surface Tokens (${mode})`}>
        <SwatchGrid>
          <Swatch name="bgFrame" value={c.bgFrame} />
          <Swatch name="bgSheet" value={c.bgSheet} />
          <Swatch name="bgStep" value={c.bgStep} />
          <Swatch name="bgHeader" value={c.bgHeader} />
          <Swatch name="bgControl" value={c.bgControl} />
          <Swatch name="wash" value={c.wash} />
          <Swatch name="wash2" value={c.wash2} />
          <Swatch name="nest" value={c.nest} />
          <Swatch name="nestHover" value={c.nestHover} />
          <Swatch name="navActive" value={c.navActive} />
          <Swatch name="field" value={c.field} />
          <Swatch name="tile" value={c.tile} />
          <Swatch name="border" value={c.border} />
          <Swatch name="borderStrong" value={c.borderStrong} />
          <Swatch name="text" value={c.text} />
          <Swatch name="text2" value={c.text2} />
          <Swatch name="text3" value={c.text3} />
          <Swatch name="accent" value={c.accent} />
          <Swatch name="inkPill" value={c.inkPill} />
          <Swatch name="inkPillText" value={c.inkPillText} />
        </SwatchGrid>
      </Section>

      {/* ─── Semantic colors ─── */}
      <Section title="Semantic Colors">
        <SwatchGrid>
          <Swatch name="purple100" value={semanticColors.purple100} />
          <Swatch name="purple200" value={semanticColors.purple200} />
          <Swatch name="purple300" value={semanticColors.purple300} />
          <Swatch name="purple500" value={semanticColors.purple500} />
          <Swatch name="mint200" value={semanticColors.mint200} />
          <Swatch name="mint300" value={semanticColors.mint300} />
          <Swatch name="mint500" value={semanticColors.mint500} />
          <Swatch name="yellow300" value={semanticColors.yellow300} />
          <Swatch name="pink300" value={semanticColors.pink300} />
          <Swatch name="green" value={semanticColors.green} />
          <Swatch name="amber" value={semanticColors.amber} />
          <Swatch name="red" value={semanticColors.red} />
        </SwatchGrid>
      </Section>

      {/* ─── Status tints ─── */}
      <Section title="Status Tints">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Badge tone="g" dot>
            g · Lista
          </Badge>
          <Badge tone="a" dot>
            a · Atención
          </Badge>
          <Badge tone="r" dot>
            r · Error
          </Badge>
          <Badge tone="i" dot>
            i · Info
          </Badge>
          <Badge tone="m" dot>
            m · Tú
          </Badge>
          <Badge tone="muted">muted</Badge>
          <Badge tone="neutral" mono>
            neutral v1.2
          </Badge>
        </View>
        <SwatchGrid>
          {(["g", "a", "r", "i", "m"] as const).map((k) => (
            <React.Fragment key={k}>
              <Swatch name={`tint.${k}.bg`} value={c.tint[k].bg} />
              <Swatch name={`tint.${k}.tx`} value={c.tint[k].tx} />
            </React.Fragment>
          ))}
        </SwatchGrid>
      </Section>

      {/* ─── Text on backgrounds ─── */}
      <Section title="Text on Backgrounds">
        <View style={{ gap: 6 }}>
          <View
            style={{
              padding: 12,
              backgroundColor: c.bgStep,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: c.border,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <T step="base">c.text on c.bgStep</T>
            <T step="sm" tone="text2">
              c.text2
            </T>
            <T step="12" tone="text3">
              c.text3
            </T>
          </View>
          <View
            style={{
              padding: 12,
              backgroundColor: c.nest,
              borderRadius: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <T step="base">c.text on c.nest</T>
            <T step="sm" tone="text2">
              c.text2
            </T>
            <T step="12" tone="text3">
              c.text3
            </T>
          </View>
          <View
            style={{
              padding: 12,
              backgroundColor: semanticColors.purple500,
              borderRadius: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <T step="base" color={semanticColors.main100}>
              main100 on purple500
            </T>
            <T step="sm" color={semanticColors.purple100}>
              purple100
            </T>
            <T step="12" color={semanticColors.purple200}>
              purple200
            </T>
          </View>
          <View
            style={{
              padding: 12,
              backgroundColor: c.tile,
              borderRadius: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <T step="base">c.text on c.tile</T>
            <T step="sm" tone="text2">
              c.text2
            </T>
            <T step="12" tone="accent">
              c.accent
            </T>
          </View>
          <View
            style={{
              padding: 12,
              backgroundColor: c.inkPill,
              borderRadius: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <T step="base" tone="inkPill">
              inkPillText on inkPill
            </T>
          </View>
        </View>
      </Section>

      {/* ─── Borders ─── */}
      <Section title="Borders">
        <View style={{ gap: 6 }}>
          <View style={{ padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 10 }}>
            <T step="12" tone="text2">
              border: c.border ({c.border})
            </T>
          </View>
          <View
            style={{ padding: 12, borderWidth: 1, borderColor: c.borderStrong, borderRadius: 10 }}
          >
            <T step="12" tone="text2">
              border: c.borderStrong ({c.borderStrong})
            </T>
          </View>
          <View
            style={{ padding: 12, borderWidth: 1, borderColor: c.borderAccent, borderRadius: 10 }}
          >
            <T step="12" tone="text2">
              border: c.borderAccent ({c.borderAccent})
            </T>
          </View>
        </View>
      </Section>
    </Page>
  )
}
