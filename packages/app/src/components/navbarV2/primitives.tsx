/**
 * NavbarV2 primitives — the sidebar row, the rail button, the style sheet and
 * the theme toggle, lifted verbatim from Navbar.tsx so the v2 rail renders with
 * exactly the same metrics (NAV-REQ-1). Navbar.tsx keeps its own private copy:
 * the flag-off path stays untouched (NAV-NFR-1).
 *
 * @spec NAV-REQ-1, NAV-REQ-14
 */
import type React from "react"
import { useMemo, useState } from "react"
import { Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { useUiPreferencesStore } from "../../store/uiPreferencesStore"
import type { LayoutNode } from "../../store/tilingStore"
import { useColors } from "../mca/primitives/useColors"
import { colors as semanticColors } from "../mca/primitives/colors"
import { FONT_MONO, FONT_SANS, FONT_SERIF } from "../mca/primitives/fonts"
import { fx } from "../../styles/fx"
import { InkToggle, Ph } from "../ui/ds"

export const MOBILE_BREAKPOINT = 768
export const COLLAPSED_WIDTH = 64
export const EXPANDED_WIDTH = 272

export interface SideItemProps {
  label: string
  sub?: string
  icon?: string
  leading?: React.ReactNode
  trailing?: React.ReactNode
  action?: React.ReactNode
  meta?: string
  on?: boolean
  /** Group row (Inactivas / Archivadas): smaller, quieter. */
  grp?: boolean
  /** Avatar rows hug the left edge (`.item.ag`). */
  tight?: boolean
  onPress?: (e?: any) => void
  testID?: string
  /** The DOM node, for the row drag of NAV-REQ-19 (RN-web forwards neither `draggable` nor drag handlers). */
  domRef?: (el: unknown) => void
}

export function SideItem({
  label,
  sub,
  icon,
  leading,
  trailing,
  action,
  meta,
  on,
  grp,
  tight,
  onPress,
  testID,
  domRef,
}: SideItemProps) {
  const c = useColors()
  const styles = useNavbarStyles()
  const [hover, setHover] = useState(false)
  return (
    <Pressable
      ref={domRef as any}
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={({ pressed }) => [
        styles.item,
        grp && styles.itemGrp,
        tight && styles.itemTight,
        (hover || pressed) && !on && styles.itemHover,
        on && styles.itemOn,
        pressed && { transform: [{ scale: 0.985 }] },
      ]}
    >
      {on ? <View {...fx("pip")} style={styles.itemPip} /> : null}
      {leading ??
        (icon ? (
          <Ph name={icon} size={grp ? 12 : 16} color={on ? c.accent : grp ? c.text3 : c.text2} />
        ) : null)}
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", gap: 4 }}>
        <Text
          style={[
            styles.itemText,
            grp && styles.itemGrpText,
            (hover || on) && { color: on ? c.accent : c.text },
            // With a role beside it the name never gives way: the role is what
            // truncates. (Alone, a long label still ellipsizes.)
            sub ? { flexShrink: 0, maxWidth: "100%" } : null,
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {sub ? (
          <Text
            style={[styles.itemSub, { minWidth: 0 }, on && { color: c.accent, opacity: 0.8 }]}
            numberOfLines={1}
          >
            · {sub}
          </Text>
        ) : null}
      </View>
      {action ? (
        // Always mounted: an action that appears on hover would grow the row
        // and shift the label; it only fades in.
        <View style={{ opacity: hover ? 1 : 0 }} pointerEvents={hover ? "auto" : "none"}>
          {action}
        </View>
      ) : meta ? (
        <Text style={styles.itemMeta}>{meta}</Text>
      ) : null}
      {trailing}
    </Pressable>
  )
}

export function RailBtn({
  icon,
  label,
  on,
  dim,
  leading,
  onPress,
  onLongPress,
  testID,
  domRef,
}: {
  icon?: string
  label: string
  on?: boolean
  /** The DOM node, for the row drag of NAV-REQ-19. */
  domRef?: (el: unknown) => void
  /** Disabled by an admin (NAV-REQ-9): quieter, still visible. */
  dim?: boolean
  /** Replaces the icon (a workspace tile, an avatar). */
  leading?: React.ReactNode
  onPress?: (e?: any) => void
  onLongPress?: (e?: any) => void
  testID?: string
}) {
  const c = useColors()
  const styles = useNavbarStyles()
  return (
    <Pressable
      ref={domRef as any}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(Platform.OS === "web" ? ({ title: label } as any) : {})}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ hovered, pressed }: any) => [
        styles.railBtn,
        (hovered || pressed) && styles.itemHover,
        on && styles.railBtnOn,
        dim && { opacity: 0.45 },
      ]}
    >
      {leading ?? <Ph name={icon ?? "browser"} size={19} color={on ? c.accent : c.text3} />}
    </Pressable>
  )
}

// ========================================
// HELPERS
// ========================================

export function findActiveWindowId(
  node: LayoutNode | null,
  containerId: string | null | undefined,
): string | null {
  if (!node || !containerId) return null
  if (node.type === "container") return node.id === containerId ? node.activeWindowId : null
  return findActiveWindowId(node.first, containerId) || findActiveWindowId(node.second, containerId)
}

/** Compact relative time for the conversation rows (language-neutral). */
export function relTime(iso?: string): string | undefined {
  if (!iso) return undefined
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return undefined
  const m = Math.floor(ms / 60000)
  if (m < 1) return "now"
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} d`
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" })
}

// ========================================
// STYLES
// ========================================


export const buildStyles = (c: ReturnType<typeof useColors>) =>
  StyleSheet.create({
    container: {
      flex: 1,
      flexDirection: "row",
      backgroundColor: c.bgFrame,
      // isolation: the side melt paints at z -1, i.e. above this background
      // and below every sidebar child, without leaking under the page.
      ...(Platform.OS === "web" && { display: "flex" as any, isolation: "isolate" as any }),
    },

    // ── Sidebar frame ──
    sidebar: {
      backgroundColor: "transparent",
      paddingHorizontal: 12,
      gap: 10,
      ...(Platform.OS === "web" && { overflow: "visible" as any }),
    },
    // Vertically centred on the 44px tab bar of the panes (arrows · tabs),
    // so the brand and the chrome read as one line: 6 + 32 / 2 = 22.
    brand: {
      flexDirection: "row",
      alignItems: "center",
      height: 32,
      marginTop: 6,
      paddingHorizontal: 2,
    },
    brandHome: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      height: 32,
      paddingLeft: 4,
      paddingRight: 8,
      borderRadius: 10,
    },

    // `.agent-switch` in the unida sidebar: a transparent row, the chip hugs
    // its content on the left and the "+" sits at the far right.
    agentRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    // `.as-chip`: a 46px wash pill — avatar · serif name · caret. No card,
    // no shadow; the hover only deepens the wash.
    agentSwitch: {
      flexShrink: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      height: 46,
      paddingLeft: 6,
      paddingRight: 14,
      borderRadius: 100,
      backgroundColor: c.wash2,
      ...(Platform.OS === "web" && ({ transition: "background 0.2s" } as any)),
    },
    agentSwitchPlaceholder: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.tile,
      alignItems: "center",
      justifyContent: "center",
    },
    agentSwitchName: {
      fontFamily: FONT_SERIF,
      fontSize: 16,
      lineHeight: 20,
      color: c.text,
      fontWeight: "400",
    },
    agentSwitchExtra: {
      fontFamily: FONT_MONO,
      fontSize: 10,
      color: c.text3,
    },
    newChat: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      ...(Platform.OS === "web" && ({ transition: "background 0.4s, transform 0.3s" } as any)),
    },

    wsRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      ...(Platform.OS === "web" && ({ zIndex: 2 } as any)),
    },

    // ── Workspace menu (`.menu`) ──
    menuBackdrop: {
      position: "fixed" as any,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 19998,
    },
    menu: {
      position: "absolute",
      top: 48,
      left: 12,
      width: EXPANDED_WIDTH - 24,
      padding: 6,
      borderRadius: 16,
      // Panel contrast (same 31-oct pass): bgStep is the page colour in dark,
      // so the floating menu's edge died against the page + border is a 4 %
      // hairline. borderStrong (7.5 % bone in dark / #E5DFEF in light) still
      // hints; the panel separates by elevRaised — text3 would be too heavy
      // for a floating panel. Light: #E5DFEF on white, unchanged.
      backgroundColor: c.bgStep,
      borderWidth: 1,
      borderColor: c.borderStrong,
      zIndex: 19999,
      elevation: 8,
      ...(Platform.OS === "web" && {
        position: "fixed" as any,
        boxShadow: c.elevRaised,
        backdropFilter: "blur(18px) saturate(1.4)" as any,
      }),
    },
    menuCollapsed: {
      ...(Platform.OS === "web" && { left: COLLAPSED_WIDTH + 8 }),
    },
    menuItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 10,
    },
    menuItemHover: { backgroundColor: c.wash },
    menuItemOn: { backgroundColor: c.navActive },
    menuItemText: {
      flex: 1,
      minWidth: 0,
      fontFamily: FONT_SANS,
      fontSize: 13,
      color: c.text,
    },
    menuItemMeta: {
      fontFamily: FONT_MONO,
      fontSize: 10,
      letterSpacing: 0.5,
      color: c.text3,
    },
    menuHr: { height: 1, backgroundColor: c.border, marginVertical: 6, marginHorizontal: 4 },

    // ── Scroll area ──
    sidebarContentWrapper: {
      flex: 1,
      position: "relative",
      marginHorizontal: -6,
    },
    sidebarContent: { flex: 1, paddingHorizontal: 6 },
    sidebarContentIn: { gap: 14, paddingBottom: 8 },
    scrollGradientTop: { position: "absolute", top: 0, left: 0, right: 0, height: 24, zIndex: 10 },
    scrollGradientBottom: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      height: 24,
      zIndex: 10,
    },

    // ── Items (`.item`) ──
    item: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 30,
      paddingVertical: 4,
      paddingLeft: 12,
      paddingRight: 8,
      borderRadius: 10,
      position: "relative",
      ...(Platform.OS === "web" &&
        ({ cursor: "pointer", transition: "background 0.2s, color 0.2s" } as any)),
    },
    itemTight: { paddingLeft: 4 },
    itemHover: { backgroundColor: c.wash },
    itemOn: { backgroundColor: c.navActive },
    itemPip: {
      position: "absolute",
      left: -8.5,
      top: "50%",
      marginTop: -2.5,
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: semanticColors.purple300,
    },
    itemText: {
      fontFamily: FONT_SANS,
      fontSize: 12.5,
      lineHeight: 17,
      color: c.text2,
      flexShrink: 1,
    },
    itemSub: {
      fontFamily: FONT_SANS,
      fontSize: 12.5,
      lineHeight: 17,
      color: c.text3,
      flexShrink: 1,
    },
    itemMeta: {
      fontFamily: FONT_MONO,
      fontSize: 10,
      color: c.text3,
    },
    itemGrp: { minHeight: 28 },
    itemGrpText: { fontSize: 12, color: c.text3 },

    // ── Layout segment (desktops) ──
    // Pablo (31-oct): with the navbar EXPANDED the desktop dots must sit
    // CENTERED in the available area — flex-end glued them to the far right,
    // which looked wrong next to the left-aligned nav sections. (The
    // collapsed rail is centered already via railFoot's alignItems center.)
    layoutSeg: {
      alignItems: "center",
      alignSelf: "stretch",
      paddingVertical: 2,
    },

    // ── User row ──
    userRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 4,
      paddingBottom: 12,
    },
    userMain: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    userAv: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.tint.m.bg,
      alignItems: "center",
      justifyContent: "center",
    },
    userAvText: {
      fontFamily: FONT_SANS,
      fontSize: 11,
      letterSpacing: 0.5,
      color: c.tint.m.tx,
    },
    userName: {
      fontFamily: FONT_SANS,
      fontSize: 13,
      lineHeight: 17,
      color: c.text,
    },
    userMeta: {
      fontFamily: FONT_MONO,
      fontSize: 9,
      letterSpacing: 0.8,
      color: c.text3,
      marginTop: 2,
    },

    // ── Rail (collapsed) ──
    rail: {
      flex: 1,
      alignItems: "center",
      gap: 8,
      paddingTop: 12,
      paddingBottom: 8,
    },
    railLogo: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
    railNew: {
      width: 40,
      height: 40,
      borderRadius: 14,
      backgroundColor: c.inkPill,
      alignItems: "center",
      justifyContent: "center",
    },
    railStories: { flex: 1, alignSelf: "stretch" },
    railStoriesIn: { alignItems: "center", gap: 8, paddingVertical: 6 },
    railStory: { padding: 3, borderRadius: 100 },
    railStoryOn: { backgroundColor: c.navActive },
    railNav: { gap: 2, marginTop: 6, alignItems: "center" },
    railBtn: {
      width: 44,
      height: 40,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    railBtnOn: { backgroundColor: c.navActive },
    railFoot: { alignItems: "center", gap: 8, paddingTop: 8 },

    // ── Main content ──
    mainContent: { flex: 1, backgroundColor: "transparent", minWidth: 0 },
    pageContent: { flex: 1 },

    // ── Mobile drawer ──
    modalOverlay: { flex: 1, flexDirection: "row" },
    modalBackdrop: { flex: 1, backgroundColor: "rgba(32,28,39,0.35)" },
    mobileSidebar: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: EXPANDED_WIDTH,
      backgroundColor: c.bgFrame,
      paddingHorizontal: 12,
      gap: 10,
    },

    // ── Create project modal ──
    scrim: {
      flex: 1,
      backgroundColor: "rgba(32,28,39,0.35)",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
    },
    modal: {
      width: 480,
      maxWidth: "100%",
      borderRadius: 24,
      backgroundColor: c.bgStep,
      overflow: "hidden",
      ...(Platform.OS === "web" && ({ boxShadow: c.elevRaised } as any)),
    },
    modalHead: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 14,
      paddingTop: 24,
      paddingHorizontal: 28,
      paddingBottom: 16,
    },
    modalBody: { paddingHorizontal: 28, paddingBottom: 24 },
    modalFoot: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 16,
      paddingHorizontal: 24,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
  })

// Hook: memoized styles that adapt to theme
export function useNavbarStyles() {
  const c = useColors()
  return useMemo(() => buildStyles(c), [c])
}

// ========================================
// THEME TOGGLE (`.toggle`)
// ========================================

export function ThemeToggleButton() {
  const theme = useUiPreferencesStore((s) => s.theme)
  const toggleTheme = useUiPreferencesStore((s) => s.toggleTheme)
  const isDark = theme === "dark"
  return (
    <InkToggle
      icon={isDark ? "sun" : "moon"}
      onPress={toggleTheme}
      title={isDark ? "Light theme" : "Dark theme"}
    />
  )
}

/**
 * The agent's avatar in a sidebar conversation row: it shows the working
 * state (the thinking glow) while that agent is working in THAT channel.
 */
