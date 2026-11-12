/**
 * useFlowEditorTheme — Theme-adaptive tokens for the Flow Editor
 *
 * The editor chrome is plain DOM (React Flow lives in a `<div>` tree), so it
 * cannot take Tamagui/RN styles directly. This hook maps the OS design
 * language (`useColors()` — the sheet / step / wash / tint roles of the
 * design-testing prototype) onto the CSS values the editor components need,
 * plus the three brand font families. Everything follows the active theme.
 *
 * `useFlowEditorStyles()` returns the shared CSS objects for the panels
 * (uppercase 10px labels, 36px fields, section headers…), so every panel
 * draws its controls the same way the ds `Field`/`FieldLabel` primitives do.
 */

import { useMemo } from "react"
import { useColors, useMcaTheme } from "../../components/mca/primitives/useColors"
import { colors as semantic, type Theme } from "../../components/mca/primitives/colors"
import { FONT_MONO, FONT_SANS, FONT_SERIF } from "../../components/mca/primitives/fonts"

// ============================================================================
// THEME INTERFACE
// ============================================================================

export interface FlowEditorTheme {
  /** Active theme name */
  theme: Theme
  /** Whether dark mode is active (convenience flag) */
  isDark: boolean

  // ── Fonts (Saans / Prody / Reddit Mono) ─────────────────────────────
  fontSans: string
  fontSerif: string
  fontMono: string

  // ── Container & Canvas ──────────────────────────────────────────────
  /** Outermost container background (the sheet) */
  containerBg: string
  /** React Flow canvas background (dots color for Background variant) */
  canvasDotColor: string

  // ── Toolbar ─────────────────────────────────────────────────────────
  toolbarBg: string
  toolbarBorder: string
  toolbarButtonBorder: string
  toolbarButtonActiveBg: string
  toolbarButtonActiveBorder: string

  // ── Sidebars (NodePalette, NodePropertiesPanel) ─────────────────────
  sidebarBg: string
  sidebarBorder: string
  sidebarHeaderText: string
  sidebarFooterText: string

  // ── Cards / Items (palette items, gate editor, etc.) ────────────────
  /** A card one step off the sheet (`--step`) */
  cardBg: string
  cardHoverBg: string
  cardBorder: string
  cardHoverBorder: string
  /** Row inside a card (`--nest`) */
  nestBg: string
  nestHoverBg: string
  /** Translucent washes for chips / hover */
  wash: string
  wash2: string
  /** Active nav/tab fill */
  navActive: string
  /** Icon tile fill */
  tile: string
  /** Violet-tinted lifts (web box-shadow strings) */
  liftSm: string
  liftSmHover: string
  elevRaised: string

  // ── Inputs ──────────────────────────────────────────────────────────
  inputBg: string
  inputBorder: string
  inputFocusBorder: string
  inputText: string
  inputPlaceholder: string

  // ── Text ────────────────────────────────────────────────────────────
  text: string
  text2: string
  text3: string
  labelText: string

  // ── Node Cards (React Flow nodes) ───────────────────────────────────
  nodeBg: string
  nodeBorder: string
  nodeBodyText: string
  nodeGateText: string
  nodeDescText: string
  nodeShadow: string
  pinNodeBg: string
  pinNodeBorder: string
  pinNodeIconColor: string

  // ── React Flow Controls ─────────────────────────────────────────────
  controlsBg: string
  controlsBorder: string
  controlsHoverBg: string
  controlsIconColor: string

  // ── MiniMap ─────────────────────────────────────────────────────────
  miniMapBg: string
  miniMapBorder: string
  miniMapMaskColor: string

  // ── Modals (ArtifactEditor, FlowSettingsPanel, ProjectPicker) ───────
  modalOverlay: string
  modalBg: string
  modalBorder: string
  modalHeaderBorder: string
  modalFooterBorder: string
  modalShadow: string
  metadataBg: string
  metadataBorder: string

  // ── Drawer ──────────────────────────────────────────────────────────
  drawerBg: string
  drawerBorder: string
  drawerShadow: string
  drawerOverlay: string

  // ── Error / Status ──────────────────────────────────────────────────
  errorBg: string
  errorBorder: string
  errorText: string
  errorDismissColor: string

  // ── Status tints (g green · a amber · r red · i violet · m mint) ────
  tint: Record<"g" | "a" | "r" | "i" | "m", { bg: string; tx: string; bd: string }>

  // ── Semantic Accents ────────────────────────────────────────────────
  /** Primary accent (violet) */
  accent: string
  /** The solid primary pill fill (Purple/300) + its text */
  primaryBg: string
  primaryText: string
  success: string
  error: string
  warning: string
  purple: string
  cyan: string
  indigo: string
}

// ============================================================================
// HOOK
// ============================================================================

export function useFlowEditorTheme(): FlowEditorTheme {
  const theme = useMcaTheme()
  const c = useColors()
  return useMemo<FlowEditorTheme>(() => {
    const isDark = theme === "dark"
    const overlay = isDark ? "rgba(0,0,0,0.55)" : "rgba(32,28,39,0.35)"
    return {
      theme,
      isDark,

      fontSans: FONT_SANS,
      fontSerif: FONT_SERIF,
      fontMono: FONT_MONO,

      containerBg: c.bgSheet,
      canvasDotColor: isDark ? "rgba(250,249,252,0.10)" : "rgba(52,47,61,0.14)",

      toolbarBg: c.bgSheet,
      toolbarBorder: c.border,
      toolbarButtonBorder: c.borderStrong,
      toolbarButtonActiveBg: c.navActive,
      toolbarButtonActiveBorder: "transparent",

      sidebarBg: c.bgSheet,
      sidebarBorder: c.border,
      sidebarHeaderText: c.text3,
      sidebarFooterText: c.text3,

      cardBg: c.bgStep,
      cardHoverBg: c.bgStep,
      cardBorder: "transparent",
      cardHoverBorder: c.borderStrong,
      nestBg: c.nest,
      nestHoverBg: c.nestHover,
      wash: c.wash,
      wash2: c.wash2,
      navActive: c.navActive,
      tile: c.tile,
      liftSm: c.liftSm,
      liftSmHover: c.liftSmHover,
      elevRaised: c.elevRaised,

      inputBg: c.field,
      inputBorder: c.border,
      inputFocusBorder: "rgba(111,39,255,0.45)",
      inputText: c.text,
      inputPlaceholder: c.text3,

      text: c.text,
      text2: c.text2,
      text3: c.text3,
      labelText: c.text2,

      nodeBg: c.bgStep,
      nodeBorder: c.border,
      nodeBodyText: c.text2,
      nodeGateText: c.text2,
      nodeDescText: c.text3,
      nodeShadow: c.liftSm,
      pinNodeBg: c.tile,
      pinNodeBorder: c.borderStrong,
      pinNodeIconColor: c.accent,

      controlsBg: c.bgStep,
      controlsBorder: "transparent",
      controlsHoverBg: c.wash2,
      controlsIconColor: c.text2,

      miniMapBg: c.bgStep,
      miniMapBorder: "transparent",
      miniMapMaskColor: isDark ? "rgba(32,28,39,0.72)" : "rgba(250,249,252,0.72)",

      modalOverlay: overlay,
      modalBg: c.bgStep,
      modalBorder: "transparent",
      modalHeaderBorder: c.border,
      modalFooterBorder: c.border,
      modalShadow: c.elevRaised,
      metadataBg: c.nest,
      metadataBorder: "transparent",

      drawerBg: c.bgSheet,
      drawerBorder: c.border,
      drawerShadow: c.elevRaised,
      drawerOverlay: overlay,

      errorBg: c.tint.r.bg,
      errorBorder: c.tint.r.bd,
      errorText: c.tint.r.tx,
      errorDismissColor: c.tint.r.tx,

      tint: c.tint,

      accent: c.accent,
      primaryBg: semantic.purple300,
      primaryText: "#FFFFFF",
      success: semantic.green,
      error: semantic.red,
      warning: semantic.amber,
      purple: c.accent,
      cyan: c.accent,
      indigo: c.accent,
    }
  }, [theme, c])
}

// ============================================================================
// SHARED PANEL STYLES — the ds Field / FieldLabel look, as CSS objects
// ============================================================================

export interface FlowEditorStyles {
  /** Uppercase 10px tracked label above a field (`FieldLabel`). */
  label: React.CSSProperties
  /** 36px field: radius 10, `field` fill, hairline border (`Field`). */
  input: React.CSSProperties
  /** Textarea variant of `input`. */
  textarea: React.CSSProperties
  /** Mono textarea (code / instructions). */
  code: React.CSSProperties
  /** 12px help text under a field (`FieldHelp`). */
  help: React.CSSProperties
  /** Section header row: xs caps label + actions. */
  sectionHeader: React.CSSProperties
  /** Row card inside a panel (`nest`). */
  nestCard: React.CSSProperties
  /** 28px pill chip (ChipBtn). */
  chip: React.CSSProperties
  chipOn: React.CSSProperties
  /** Quiet round icon button (IconBtn plain). */
  iconBtn: React.CSSProperties
  /** Outlined 36px pill (Btn sec). */
  btnSec: React.CSSProperties
  /** Ghost 36px pill (Btn ghost). */
  btnGhost: React.CSSProperties
  /** Violet 36px pill (Btn primary). */
  btnPrimary: React.CSSProperties
  /** Subtle 28px pill for in-panel actions. */
  btnSm: React.CSSProperties
}

export function useFlowEditorStyles(): FlowEditorStyles {
  const t = useFlowEditorTheme()
  return useMemo<FlowEditorStyles>(() => {
    const pill: React.CSSProperties = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      height: 36,
      padding: "0 16px",
      borderRadius: 100,
      fontFamily: t.fontSans,
      fontSize: 13,
      fontWeight: 400,
      lineHeight: 1,
      cursor: "pointer",
      whiteSpace: "nowrap",
      flexShrink: 0,
      transition: "background 0.2s, border-color 0.2s, color 0.2s",
    }
    const input: React.CSSProperties = {
      width: "100%",
      height: 36,
      background: t.inputBg,
      border: `1px solid ${t.inputBorder}`,
      borderRadius: 10,
      padding: "0 14px",
      color: t.inputText,
      fontSize: 13,
      fontWeight: 400,
      fontFamily: t.fontSans,
      outline: "none",
      boxSizing: "border-box",
    }
    return {
      label: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontFamily: t.fontSans,
        fontSize: 10,
        fontWeight: 400,
        lineHeight: "12px",
        color: t.labelText,
        textTransform: "uppercase",
        letterSpacing: 1.8,
        marginBottom: 8,
      },
      input,
      textarea: {
        ...input,
        height: "auto",
        minHeight: 72,
        padding: "10px 14px",
        lineHeight: "20px",
        resize: "vertical",
      },
      code: {
        ...input,
        height: "auto",
        minHeight: 96,
        padding: "10px 14px",
        lineHeight: "18px",
        resize: "vertical",
        fontFamily: t.fontMono,
        fontSize: 12,
      },
      help: {
        fontFamily: t.fontSans,
        fontSize: 12,
        lineHeight: "16px",
        color: t.text3,
        marginTop: 8,
      },
      sectionHeader: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontFamily: t.fontSans,
        fontSize: 10,
        fontWeight: 400,
        lineHeight: "12px",
        color: t.text2,
        textTransform: "uppercase",
        letterSpacing: 1.8,
        paddingBottom: 10,
        borderBottom: `1px solid ${t.sidebarBorder}`,
      },
      nestCard: {
        background: t.nestBg,
        borderRadius: 12,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontFamily: t.fontSans,
      },
      chip: {
        ...pill,
        height: 28,
        padding: "0 12px",
        fontSize: 12,
        background: t.wash,
        border: "1px solid transparent",
        color: t.text2,
      },
      chipOn: {
        background: t.navActive,
        color: t.accent,
      },
      iconBtn: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        padding: 0,
        borderRadius: 100,
        background: "transparent",
        border: "none",
        color: t.text2,
        cursor: "pointer",
        flexShrink: 0,
        transition: "background 0.2s, color 0.2s",
      },
      btnSec: {
        ...pill,
        background: "transparent",
        border: `1px solid ${t.toolbarButtonBorder}`,
        color: t.text,
      },
      btnGhost: {
        ...pill,
        background: "transparent",
        border: "1px solid transparent",
        color: t.text2,
      },
      btnPrimary: {
        ...pill,
        background: t.primaryBg,
        border: "1px solid transparent",
        color: t.primaryText,
      },
      btnSm: {
        ...pill,
        height: 28,
        padding: "0 12px",
        fontSize: 12,
        background: t.wash,
        border: "1px solid transparent",
        color: t.text2,
      },
    }
  }, [t])
}
