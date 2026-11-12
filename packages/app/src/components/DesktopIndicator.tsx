import React, { useMemo, useRef, useState } from "react"
import { Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native"
import { useTilingStore, MAX_DESKTOPS } from "../store/tilingStore"
import { useColors } from "./mca/primitives/useColors"
import { colors as semanticColors } from "./mca/primitives/colors"

interface DesktopIndicatorProps {
  /** Whether to show in collapsed mode (vertical layout) */
  collapsed?: boolean
}

const TILE_WIDTH = 22
const TILE_HEIGHT = 16
const TILE_RADIUS = 5
const INNER_RECT_WIDTH = 12
const INNER_RECT_HEIGHT = 7
const INNER_RECT_RADIUS = 2
const PLUS_SIZE = 14
/** Pablo (30-oct): the X must be BIG and easy to hit — not the typical tiny one. */
const CLOSE_BTN = 20
const CLOSE_SIZE = 14

/**
 * Desktop/Workspace indicator for the navbar (OS prototype, Oct 2026).
 * A washed pill holding one small rounded tile per desktop: the active one is
 * a violet fill, the others a hairline outline. If a desktop contains windows,
 * a small inner rectangle is shown. Clicking a desktop switches to it.
 * When a drag is in progress (globalDragWindowId != null), tiles become drop targets
 * to move the dragged window to another desktop.
 *
 * Dynamic desktops — Pablo's design update (30-oct, task tn_pA4USvSgNqk9NLS3):
 * - A "+" tile at the right creates a new desktop (hard cap MAX_DESKTOPS = 10,
 *   disabled at the cap).
 * - NO X is ever visible in normal mode (accidental clicks — Pablo's rule).
 * - EMPTY desktops delete directly from their tile (safe operation, no
 *   friction); desktops WITH windows need the explicit edit mode.
 * - Edit mode: right-click (web) / long-press (native) on the dots shows a
 *   BIG × on every removable tile. Clicking the × removes that desktop —
 *   its windows migrate to the previous desktop (store rule). The last
 *   remaining desktop can never be removed.
 * - Contrast in dark AND light via design-system tokens only (accent, text,
 *   tint.r for the destructive ×) — no fixed colors.
 */
export function DesktopIndicator({ collapsed = false }: DesktopIndicatorProps) {
  const c = useColors()
  const styles = useMemo(() => buildStyles(c), [c])

  const desktops = useTilingStore((state) => state.desktops)
  const activeDesktopIndex = useTilingStore((state) => state.activeDesktopIndex)
  const switchToDesktop = useTilingStore((state) => state.switchToDesktop)
  const windows = useTilingStore((state) => state.windows)
  const moveWindowToDesktop = useTilingStore((state) => state.moveWindowToDesktop)
  const addDesktop = useTilingStore((state) => state.addDesktop)
  const removeDesktop = useTilingStore((state) => state.removeDesktop)
  const globalDragWindowId = useTilingStore((state) => state.globalDragWindowId)
  const globalDragWindowIds = useTilingStore((state) => state.globalDragWindowIds)
  const globalDragIsGroup = useTilingStore((state) => state.globalDragIsGroup)
  const clearGlobalDrag = useTilingStore((state) => state.clearGlobalDrag)

  const isDragging = globalDragWindowId !== null || globalDragIsGroup
  const atCap = desktops.length >= MAX_DESKTOPS
  const canRemoveAny = desktops.length > 1

  // Edit mode (explicit): Xs appear ONLY here. Web: right-click on the strip;
  // native: long-press on a tile. Any desktop switch or removal exits it.
  const [editMode, setEditMode] = useState(false)

  // Track which tile is being hovered during a drag
  const [hoveredTileIndex, setHoveredTileIndex] = useState<number | null>(null)

  // ── Right-click → edit mode (web). The CrewRail pattern: one stable
  // listener per node via a ref, so re-renders never leak listeners. ────────
  const stripRef = useRef<HTMLElement | null>(null)
  const ctxRef = useRef(() => setEditMode(true))
  ctxRef.current = () => setEditMode(true)
  const onContextMenu = useRef((e: Event) => {
    e.preventDefault()
    ctxRef.current()
  }).current
  const setStripRef = (el: unknown) => {
    if (Platform.OS !== "web") return
    stripRef.current?.removeEventListener("contextmenu", onContextMenu)
    stripRef.current = el instanceof HTMLElement ? el : null
    stripRef.current?.addEventListener("contextmenu", onContextMenu)
  }

  /** Windows on desktop i (empty → quick-delete allowed without edit mode). */
  const windowCount = (i: number) =>
    Object.values(windows).filter((w) => w.desktopIndex === i).length

  return (
    <View
      ref={setStripRef as any}
      style={[styles.container, collapsed && styles.containerCollapsed]}
    >
      {desktops.map((desktop, index) => {
        const isActive = index === activeDesktopIndex
        const hasWindows = windowCount(index) > 0
        const isDroppable = isDragging && !isActive
        const isHovered = hoveredTileIndex === index
        // Pablo (30-oct, feedback 2): NO X on the dots for empty desktops
        // either — "no le gustan nada". Empty-desktop deletion lives INSIDE
        // the empty desktop view (EmptyDesktopHeader), not on the dots. The
        // dots only ever show Xs in the explicit edit mode (desktops WITH
        // windows are the destructive case that needs the friction).
        const showsX = editMode && canRemoveAny && !isDragging
        const removable = canRemoveAny && !isDragging

        return (
          <View key={desktop.id} style={styles.tileWrap}>
            <TouchableOpacity
              testID={`desktop-tile-${index}`}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              style={[
                styles.tile,
                !isActive && !isDroppable && styles.tileInactive,
                isActive && styles.tileActive,
                isDroppable && styles.tileDroppable,
                isDroppable && isHovered && styles.tileDroppableHover,
              ]}
              onPress={() => {
                if (editMode) setEditMode(false)
                switchToDesktop(index)
              }}
              // Native: long-press enters edit mode (the web right-click twin)
              onLongPress={
                Platform.OS === "web" || !removable
                  ? undefined
                  : () => setEditMode(true)
              }
              activeOpacity={0.7}
              // HTML5 drag-and-drop handlers (web only)
              {...(isDragging && {
                onDragOver: (e: any) => {
                  e.preventDefault()
                  setHoveredTileIndex(index)
                },
                onDragLeave: () => {
                  setHoveredTileIndex(null)
                },
                onDrop: (e: any) => {
                  e.preventDefault()
                  setHoveredTileIndex(null)

                  if (globalDragIsGroup) {
                    // Move all windows in the group
                    globalDragWindowIds.forEach((wid) => {
                      moveWindowToDesktop(wid, index)
                    })
                  } else if (globalDragWindowId) {
                    moveWindowToDesktop(globalDragWindowId, index)
                  }

                  clearGlobalDrag()
                  switchToDesktop(index)
                },
              })}
            >
              {hasWindows && <View style={[styles.innerRect, isActive && styles.innerRectActive]} />}
            </TouchableOpacity>

            {/* ── The X ──
                ONLY in edit mode (right-click / long-press). Never on the
                last desktop, never mid-drag, NEVER in normal mode — not even
                for empty desktops (Pablo: deletion of empties lives inside
                the empty desktop view, not on the dots). BIG, high contrast,
                tint.r in both themes. */}
            {showsX && (
              <TouchableOpacity
                testID={`desktop-remove-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`Eliminar ${desktop.name ?? `Desktop ${index + 1}`}`}
                style={[styles.closeBtn, isActive && styles.closeBtnActive]}
                onPress={() => {
                  removeDesktop(index)
                  setEditMode(false)
                }}
                activeOpacity={0.7}
                hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
              >
                <Text style={styles.closeX}>×</Text>
              </TouchableOpacity>
            )}
          </View>
        )
      })}

      {/* Create desktop — hard cap MAX_DESKTOPS (10), disabled at the cap.
          In edit mode the + stays available (creating is not destructive). */}
      <TouchableOpacity
        testID="desktop-add"
        accessibilityRole="button"
        accessibilityLabel="Nuevo desktop"
        accessibilityState={{ disabled: atCap }}
        style={[styles.addTile, atCap && styles.addTileDisabled]}
        onPress={() => {
          if (atCap) return
          addDesktop()
          setEditMode(false)
        }}
        activeOpacity={0.7}
        disabled={atCap}
      >
        <Text style={[styles.addPlus, atCap && styles.addPlusDisabled]}>+</Text>
      </TouchableOpacity>

      {/* Edit-mode affordance hint (web): a tiny pencil only while editing,
          so the exit is discoverable without adding chrome to normal mode. */}
      {editMode && (
        <TouchableOpacity
          testID="desktop-edit-exit"
          accessibilityRole="button"
          accessibilityLabel="Salir del modo edición"
          style={styles.editExitBtn}
          onPress={() => setEditMode(false)}
          activeOpacity={0.7}
        >
          <Text style={styles.editExitText}>✓</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

const buildStyles = (c: ReturnType<typeof useColors>) =>
  StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 5,
      paddingHorizontal: 8,
      backgroundColor: c.wash,
      borderRadius: 100,
    },
    containerCollapsed: {
      flexDirection: "column",
      paddingVertical: 8,
      paddingHorizontal: 5,
    },
    tileWrap: {
      position: "relative",
    },
    tile: {
      width: TILE_WIDTH,
      height: TILE_HEIGHT,
      borderRadius: TILE_RADIUS,
      justifyContent: "center",
      alignItems: "center",
      borderWidth: 1,
      ...(Platform.OS === "web"
        ? ({ transition: "background 0.2s, border-color 0.2s, box-shadow 0.3s" } as any)
        : null),
    },
    // ── Inactive tile contrast (Pablo, 31-oct r2 + r3): r2 made the inactive
    // desktop a filled, recessed dot (bgInner + text3 border) — visible in
    // both themes, but r3 came back "pasadas de contraste": the DARK GRAY was
    // one notch too strong. The border KEEPS text3 (#968FA7 in both themes —
    // the contrast carrier; borderStrong was invisible in light and there is
    // no token between the two). The notch comes off the FILL: bgInner (dark
    // neutral — light rgba(52,47,61,0.05) / dark rgba(0,0,0,0.22)) → wash2, a
    // soft theme-hued body (light lavender rgba(207,197,226,0.30) / dark bone
    // rgba(250,249,252,0.07)). The "gris oscuro" is gone in both themes; the
    // pill keeps its body and the border keeps it legible.
    tileInactive: {
      backgroundColor: c.wash2,
      borderColor: c.text3,
    },
    tileActive: {
      backgroundColor: c.accent,
      borderColor: c.accent,
      ...(Platform.OS === "web"
        ? ({ boxShadow: c.liftSm } as any)
        : null),
    },
    tileDroppable: {
      backgroundColor: c.navActive,
      borderWidth: 1,
      borderColor: c.borderAccent,
      borderStyle: "dashed",
      width: TILE_WIDTH,
      height: TILE_HEIGHT,
      borderRadius: TILE_RADIUS,
    },
    tileDroppableHover: {
      backgroundColor: c.accent,
      borderColor: c.accent,
      borderStyle: "solid",
      opacity: 0.8,
    },
    // innerRect: the "has windows" mark inside the tile. borderStrong died on
    // the new bgInner fill (both themes) — text3 reads on it in dark+light.
    innerRect: {
      width: INNER_RECT_WIDTH,
      height: INNER_RECT_HEIGHT,
      borderRadius: INNER_RECT_RADIUS,
      backgroundColor: c.text3,
    },
    innerRectActive: {
      backgroundColor: "rgba(255,255,255,0.85)",
    },
    // ── Dynamic desktops (Pablo, 30-oct): + and × ──────────────────────────
    addTile: {
      width: TILE_WIDTH,
      height: TILE_HEIGHT,
      borderRadius: TILE_RADIUS,
      justifyContent: "center",
      alignItems: "center",
      borderWidth: 1,
      borderStyle: "dashed",
      // text3 (not borderStrong): the dashed + must be visible on the wash in
      // light too (Pablo, 31-oct review — same contrast pass as tileInactive).
      borderColor: c.text3,
      backgroundColor: "transparent",
      ...(Platform.OS === "web"
        ? ({ transition: "background 0.2s, border-color 0.2s" } as any)
        : null),
    },
    addTileDisabled: {
      opacity: 0.35,
      borderColor: c.text3,
    },
    addPlus: {
      fontSize: PLUS_SIZE,
      lineHeight: TILE_HEIGHT,
      // text2: readable on wash in BOTH themes (dark #CFC5E2 / light #575263)
      color: c.text2,
      fontWeight: "600",
    },
    addPlusDisabled: {
      color: c.text3,
    },
    /** BIG × (Pablo: "más grandes de lo típico, con protagonismo") — a 20px
     * pill with a 14px glyph, tint.r in both themes (dark tx #FEE2E2 on
     * rgba(239,68,68,0.09) / light tx #EF4444 on #FEE2E2) + borderAccent ring
     * so it pops on the wash in dark AND light. */
    closeBtn: {
      position: "absolute",
      top: -9,
      right: -9,
      width: CLOSE_BTN,
      height: CLOSE_BTN,
      borderRadius: CLOSE_BTN / 2,
      backgroundColor: c.tint.r.bg,
      borderWidth: 1,
      borderColor: c.tint.r.bd,
      justifyContent: "center",
      alignItems: "center",
      zIndex: 10,
      ...(Platform.OS === "web"
        ? ({ boxShadow: c.liftSm } as any)
        : null),
    },
    closeBtnActive: {
      borderColor: c.borderAccentStrong,
    },
    closeX: {
      fontSize: CLOSE_SIZE,
      lineHeight: CLOSE_BTN,
      color: c.tint.r.tx,
      fontWeight: "700",
      marginTop: -1,
    },
    /** Exit-edit ✓ — small, quiet (it is the safe action). */
    editExitBtn: {
      width: TILE_WIDTH,
      height: TILE_HEIGHT,
      borderRadius: TILE_RADIUS,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: c.navActive,
      borderWidth: 1,
      borderColor: c.borderAccent,
    },
    editExitText: {
      fontSize: 11,
      lineHeight: TILE_HEIGHT,
      color: c.accent,
      fontWeight: "700",
    },
  })
