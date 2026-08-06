/**
 * TilingContainer - A container with tabs in the tiling layout
 *
 * Features:
 * - Tabs for multiple windows (individually draggable)
 * - Grip handle to drag the entire tab group
 * - Drop zones on edges: left, right, bottom (create splits)
 * - Drop on center: swap content
 * - Drop on tab bar: insert at specific position
 * - Title and notification syncing with chatStore
 */

import {
  ChevronLeft,
  ChevronRight,
  Columns,
  GripVertical,
  Lock,
  MoreVertical,
  Plus,
  Rows,
  Trash2,
  X,
} from "@tamagui/lucide-icons"
import React, { useCallback, useRef, useState } from "react"
import { Platform, View } from "react-native"
import { useTranslation } from "react-i18next"
import { Circle, Popover, Separator, Text, XStack, YStack } from "tamagui"
import { useTabState } from "../../hooks/useTabState"
import { windowRegistry } from "../../services/windowRegistry"
import {
  type ContainerNode,
  selectActiveContainerId,
  useTilingStore,
} from "../../store/tilingStore"
import { TerosLoading } from "../TerosLoading"
import { useColors } from "../mca/primitives/useColors"
import { colors as semanticColors, surface } from "../mca/primitives/colors"
import { type DropZone, useDragDrop } from "./DragDropContext"
import { WindowContent } from "./WindowContent"
import { TabContext, type TabContextValue } from "./TabContext"
import { ConcaveCorner, TAB_RADIUS } from "./ConcaveCorner"

interface Props {
  container: ContainerNode
}

// Size of the drop zones at the edges (in pixels)
const DROP_ZONE_SIZE = 60

// Design tokens
const CONTENT_RADIUS = 4

// Adaptive tab colors — built from theme tokens
/**
 * Composite a semi-transparent rgba color over an opaque hex background.
 * Returns an opaque hex color. Eliminates transparency headaches in SVG/tab rendering.
 */
function compositeOver(rgba: string, bg: string): string {
  const m = rgba.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/)
  if (!m) return rgba
  const r = Number(m[1]), g = Number(m[2]), b = Number(m[3])
  const a = m[4] !== undefined ? Number(m[4]) : 1
  if (a >= 1) return rgba
  const bm = bg.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!bm) return rgba
  const br = parseInt(bm[1], 16), bg2 = parseInt(bm[2], 16), bb = parseInt(bm[3], 16)
  const rr = Math.round(r * a + br * (1 - a))
  const rg = Math.round(g * a + bg2 * (1 - a))
  const rb = Math.round(b * a + bb * (1 - a))
  return `#${rr.toString(16).padStart(2, "0")}${rg.toString(16).padStart(2, "0")}${rb.toString(16).padStart(2, "0")}`
}

function buildTabColors(c: ReturnType<typeof useColors>) {
  const isDark = c.bgPage === surface.dark.bgPage
  // Tab bar is always opaque — composite semi-transparent tokens over it
  const tabBar = isDark ? "#080809" : "#C8C8C8"
  const activeBg = compositeOver(c.bgCard, tabBar)
  const activeBorder = compositeOver(c.borderStrong, tabBar)
  return {
    active: {
      border: activeBorder,
      background: activeBg,
      tabText: c.text,
    },
    inactive: {
      border: isDark ? "#222" : "#B8B8B8",
      background: isDark ? "#0a0a0b" : "#D0D0D0",
      tabText: isDark ? c.text3 : "#5A5A5A",
    },
    // Tab bar: clearly darker strip behind the tabs
    tabBar,
    // Inactive tabs: opaque, slightly lighter than tab bar
    inactiveTab: isDark ? "#0e0e10" : "#D0D0D0",
    inactiveTabText: isDark ? c.text3 : "#5A5A5A",
    // Hover backgrounds for buttons in the tab bar
    hoverBg: isDark ? "#1a1a1a" : "#D8D8D8",
    // Icon color for tab bar buttons (grip, nav, close, menu)
    iconDim: c.text3,
    iconMid: c.text2,
    // Menu popover
    menuBg: c.bgCard,
    menuBorder: c.borderStrong,
    menuHover: isDark ? "#1f1f1f" : c.bgCardHover,
    menuSeparator: c.borderStrong,
    // Empty pane text
    emptyText: c.text3,
    emptySubtext: c.text3,
    // Close button hover
    closeHover: isDark ? "#333" : "#D8D8D8",
    // Inactive tab hover
    inactiveTabHover: isDark ? "#151515" : "#D8D8D8",
    // Ghost drag image
    ghostBg: isDark ? "#1a1a1a" : c.bgCard,
    ghostBorder: isDark ? "rgba(255,255,255,0.12)" : c.border,
    ghostText: c.text,
    // Drop zone accent (was cyan #06B6D4 → indigo #5E6AD2)
    dropAccent: semanticColors.indigo,
    dropAccentBg: "rgba(94,106,210,0.15)",
    dropAccentBgSubtle: "rgba(94,106,210,0.10)",
    dropAccentBorder: "rgba(94,106,210,0.5)",
    // Status dots
    redDot: semanticColors.red,
    blueDot: semanticColors.indigo,
    // Lock icon on active tab
    lockActive: semanticColors.indigo,
    // Lock icon on inactive tab
    lockInactive: c.text3,
  }
}

type TabColors = ReturnType<typeof buildTabColors>

export function TilingContainer({ container }: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const TC = buildTabColors(c)
  const [tabDropIndex, setTabDropIndex] = useState<number | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const tabBarRef = useRef<HTMLDivElement | null>(null)

  const {
    windows,
    setActiveTab,
    focusContainer,
    closeWindow,
    splitContainer,
    closeContainer,
    openWindow,
    navigateBack,
    navigateForward,
  } = useTilingStore()

  // Use selectors for derived state from active desktop
  const activeContainerId = useTilingStore(selectActiveContainerId)

  // Drag & drop context
  const { dragState, dropTarget, startDrag, startGroupDrag, setDropTarget, endDrag, isDragging } =
    useDragDrop()

  const isActive = activeContainerId === container.id
  const containerWindows = container.windowIds.map((id) => windows[id]).filter(Boolean)
  const activeWindow = container.activeWindowId ? windows[container.activeWindowId] : null

  const colors = isActive ? TC.active : TC.inactive

  // Back / forward navigation state for the active window
  const canGoBack = activeWindow
    ? (activeWindow.historyIndex ?? 0) > 0
    : false
  const canGoForward = activeWindow
    ? (activeWindow.historyIndex ?? 0) < (activeWindow.history?.length ?? 1) - 1
    : false

  // Check if this container is the drop target
  const isDropTarget = dropTarget?.containerId === container.id
  const currentDropZone = isDropTarget ? dropTarget.zone : null

  // ========================================
  // DROP ZONE DETECTION
  // ========================================

  const handleDragOver = useCallback(
    (e: React.DragEvent | any) => {
      if (!isDragging) return
      e.preventDefault()

      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return

      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const width = rect.width
      const height = rect.height

      // Check if in tab bar area first (top 34px)
      const tabBarRect = tabBarRef.current?.getBoundingClientRect()
      if (tabBarRect && e.clientY >= tabBarRect.top && e.clientY <= tabBarRect.bottom) {
        // In tab bar - calculate insertion index
        const tabIndex = calculateTabDropIndex(e.clientX, tabBarRect)
        setDropTarget({ containerId: container.id, zone: "tabs", tabIndex })
        setTabDropIndex(tabIndex)
        return
      }

      setTabDropIndex(null)

      // Check border zones for splits, and center for swap
      let zone: DropZone | null = null

      if (x < DROP_ZONE_SIZE) {
        zone = "left"
      } else if (x > width - DROP_ZONE_SIZE) {
        zone = "right"
      } else if (y > height - DROP_ZONE_SIZE) {
        zone = "bottom"
      } else {
        // Centro - solo si no es el mismo container de origen
        if (dragState?.sourceContainerId !== container.id) {
          zone = "center"
        }
      }

      if (zone) {
        setDropTarget({ containerId: container.id, zone })
      } else {
        if (dropTarget?.containerId === container.id) {
          setDropTarget(null)
        }
      }
    },
    [isDragging, container.id, setDropTarget, dropTarget, dragState],
  )

  const calculateTabDropIndex = useCallback((clientX: number, tabBarRect: DOMRect): number => {
    const tabElements = tabBarRef.current?.querySelectorAll("[data-tab]")
    if (!tabElements || tabElements.length === 0) {
      return 0
    }

    for (let i = 0; i < tabElements.length; i++) {
      const tab = tabElements[i] as HTMLElement
      const tabRect = tab.getBoundingClientRect()
      const tabCenter = tabRect.left + tabRect.width / 2

      if (clientX < tabCenter) {
        return i
      }
    }

    return tabElements.length
  }, [])

  const handleDragLeave = useCallback(
    (e: React.DragEvent | any) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return

      const x = e.clientX
      const y = e.clientY

      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        if (dropTarget?.containerId === container.id) {
          setDropTarget(null)
        }
        setTabDropIndex(null)
      }
    },
    [container.id, dropTarget, setDropTarget],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent | any) => {
      e.preventDefault()
      endDrag()
      setTabDropIndex(null)
    },
    [endDrag],
  )

  // ========================================
  // HANDLERS
  // ========================================

  const handleContainerPress = () => {
    if (!isActive && !isDragging) {
      focusContainer(container.id)
    }
  }

  // ========================================
  // WEB EVENT HANDLERS
  // ========================================

  const webEventHandlers =
    Platform.OS === "web"
      ? {
          onDragOver: handleDragOver,
          onDragLeave: handleDragLeave,
          onDrop: handleDrop,
        }
      : {}

  const setRef = useCallback((node: View | null) => {
    if (Platform.OS === "web" && node) {
      containerRef.current = node as unknown as HTMLDivElement
    }
  }, [])

  const setTabBarRefCallback = useCallback((node: View | null) => {
    if (Platform.OS === "web" && node) {
      tabBarRef.current = node as unknown as HTMLDivElement
    }
  }, [])

  // ========================================
  // GROUP DRAG (grip handle)
  // ========================================

  const handleGripDragStart = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation()
      const windowIds = container.windowIds
      const title =
        containerWindows.length > 1
          ? `${containerWindows.length} tabs`
          : (windowRegistry.get(containerWindows[0]?.type)?.getTitle(containerWindows[0]?.props) ??
            "Window")
      startGroupDrag(windowIds, container.id, title)

      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move"
        e.dataTransfer.setData("text/plain", "group")

        // Custom ghost image
        const ghost = document.createElement('div')
        ghost.textContent = title
        ghost.style.cssText = [
          'position:absolute',
          'top:-1000px',
          'left:-1000px',
          `background:${TC.ghostBg}`,
          `border:1px solid ${TC.ghostBorder}`,
          'border-radius:8px',
          'padding:6px 12px',
          'font-size:12px',
          `color:${TC.ghostText}`,
          'white-space:nowrap',
          'pointer-events:none',
        ].join(';')
        document.body.appendChild(ghost)
        e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2)
        setTimeout(() => document.body.removeChild(ghost), 0)
      }
    },
    [container.id, container.windowIds, containerWindows, startGroupDrag],
  )

  const handleGripDragEnd = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation()
      endDrag()
    },
    [endDrag],
  )

  // ========================================
  // DROP ZONE INDICATORS
  // ========================================

  const renderDropZoneIndicators = () => {
    if (!isDragging) return null
    // Don't show if dragging from this container and it's the only source
    if (dragState?.sourceContainerId === container.id && !dragState.isGroup) {
      if (containerWindows.length <= 1) return null
    }
    // For group drag, don't show on source container at all
    if (dragState?.isGroup && dragState?.sourceContainerId === container.id) {
      return null
    }

    return (
      <>
        {/* Left zone indicator */}
        {currentDropZone === "left" && (
          <YStack
            position="absolute"
            top={34}
            left={0}
            bottom={0}
            width="40%"
            backgroundColor={TC.dropAccentBg}
            borderWidth={2}
            borderColor={TC.dropAccent}
            borderRadius={6}
            justifyContent="center"
            alignItems="center"
            pointerEvents="none"
            zIndex={100}
          >
            <Columns size={24} color={TC.dropAccent} />
            <Text color={TC.dropAccent} fontSize={11} marginTop={4}>
              {t('windows.splitLeft')}
            </Text>
          </YStack>
        )}

        {/* Right zone indicator */}
        {currentDropZone === "right" && (
          <YStack
            position="absolute"
            top={34}
            right={0}
            bottom={0}
            width="40%"
            backgroundColor={TC.dropAccentBg}
            borderWidth={2}
            borderColor={TC.dropAccent}
            borderRadius={6}
            justifyContent="center"
            alignItems="center"
            pointerEvents="none"
            zIndex={100}
          >
            <Columns size={24} color={TC.dropAccent} />
            <Text color={TC.dropAccent} fontSize={11} marginTop={4}>
              {t('windows.splitRight')}
            </Text>
          </YStack>
        )}

        {/* Bottom zone indicator */}
        {currentDropZone === "bottom" && (
          <YStack
            position="absolute"
            left={0}
            right={0}
            bottom={0}
            height="40%"
            backgroundColor={TC.dropAccentBg}
            borderWidth={2}
            borderColor={TC.dropAccent}
            borderRadius={6}
            justifyContent="center"
            alignItems="center"
            pointerEvents="none"
            zIndex={100}
          >
            <Rows size={24} color={TC.dropAccent} />
            <Text color={TC.dropAccent} fontSize={11} marginTop={4}>
              {t('windows.splitBottom')}
            </Text>
          </YStack>
        )}

        {/* Tab bar highlight when dropping on tabs */}
        {currentDropZone === "tabs" && (
          <XStack
            position="absolute"
            top={0}
            left={0}
            right={0}
            height={34}
            backgroundColor={TC.dropAccentBgSubtle}
            borderWidth={2}
            borderColor={TC.dropAccentBorder}
            borderRadius={4}
            pointerEvents="none"
            zIndex={100}
          />
        )}

        {/* Center zone indicator (swap) */}
        {currentDropZone === "center" && (
          <YStack
            position="absolute"
            top={34}
            left={DROP_ZONE_SIZE}
            right={DROP_ZONE_SIZE}
            bottom={DROP_ZONE_SIZE}
            backgroundColor={TC.dropAccentBgSubtle}
            borderWidth={2}
            borderColor={TC.dropAccentBorder}
            borderRadius={6}
            justifyContent="center"
            alignItems="center"
            pointerEvents="none"
            zIndex={100}
          >
            <XStack gap={8} alignItems="center">
              <Text color={TC.dropAccent} fontSize={18}>
                ⇄
              </Text>
              <Text color={TC.dropAccent} fontSize={12} fontWeight="600">
                Intercambiar
              </Text>
            </XStack>
          </YStack>
        )}
      </>
    )
  }

  return (
    <YStack
      ref={setRef as any}
      flex={1}
      margin={2}
      position="relative"
      overflow="visible"
      onPress={handleContainerPress}
      {...webEventHandlers}
    >
      {/* Tab bar */}
      <XStack
        ref={setTabBarRefCallback as any}
        height={39}
        backgroundColor={TC.tabBar}
        alignItems="flex-end"
        position="relative"
        zIndex={2}
        overflow="visible"
      >
        {/* Drag handle for group - draggable */}
        <XStack
          width={26}
          height={26}
          marginLeft={4}
          justifyContent="center"
          alignItems="center"
          borderRadius={4}
          opacity={containerWindows.length > 0 ? 0.4 : 0.2}
          cursor={containerWindows.length > 0 ? "grab" : "default"}
          hoverStyle={
            containerWindows.length > 0 ? { backgroundColor: TC.hoverBg, opacity: 0.8 } : {}
          }
          alignSelf="center"
          // @ts-expect-error - Web drag events
          draggable={Platform.OS === "web" && containerWindows.length > 0}
          onDragStart={Platform.OS === "web" ? handleGripDragStart : undefined}
          onDragEnd={Platform.OS === "web" ? handleGripDragEnd : undefined}
        >
          <GripVertical size={14} color={TC.iconDim} />
        </XStack>

        {/* Back / Forward navigation buttons */}
        <XStack alignSelf="center" gap={0}>
          <XStack
            width={24}
            height={24}
            justifyContent="center"
            alignItems="center"
            borderRadius={4}
            opacity={canGoBack ? 0.7 : 0.2}
            cursor={canGoBack ? "pointer" : "default"}
            hoverStyle={canGoBack ? { backgroundColor: TC.hoverBg, opacity: 1 } : {}}
            onPress={canGoBack && activeWindow ? () => navigateBack(activeWindow.id) : undefined}
          >
            <ChevronLeft size={14} color={TC.iconDim} />
          </XStack>
          <XStack
            width={24}
            height={24}
            justifyContent="center"
            alignItems="center"
            borderRadius={4}
            opacity={canGoForward ? 0.7 : 0.2}
            cursor={canGoForward ? "pointer" : "default"}
            hoverStyle={canGoForward ? { backgroundColor: TC.hoverBg, opacity: 1 } : {}}
            onPress={canGoForward && activeWindow ? () => navigateForward(activeWindow.id) : undefined}
          >
            <ChevronRight size={14} color={TC.iconDim} />
          </XStack>
        </XStack>

        {/* Tabs with drop indicators - flex distribution like Chrome */}
        <XStack flex={1} alignItems="flex-end" overflow="visible">
          {containerWindows.map((window, index) => (
            <React.Fragment key={window.id}>
              {/* Drop indicator before this tab */}
              {tabDropIndex === index && currentDropZone === "tabs" && <TabDropIndicator />}
              <DraggableTab
                window={window}
                containerId={container.id}
                isActive={container.activeWindowId === window.id}
                isContainerActive={isActive}
                onSelect={() => setActiveTab(container.id, window.id)}
                onClose={() => closeWindow(window.id)}
                tabCount={containerWindows.length}
              />
            </React.Fragment>
          ))}
          {/* Drop indicator after all tabs */}
          {tabDropIndex === containerWindows.length && currentDropZone === "tabs" && (
            <TabDropIndicator />
          )}

          {/* Launcher button (+) - right after the last tab */}
          <XStack
            alignSelf="center"
            width={26}
            height={26}
            justifyContent="center"
            alignItems="center"
            opacity={0.4}
            hoverStyle={{ backgroundColor: TC.hoverBg, opacity: 0.8 }}
            borderRadius={4}
            cursor="pointer"
            marginLeft={4}
            onPress={() => openWindow("launcher", {}, true, activeWindow?.id)}
          >
            <Plus size={14} color={TC.iconDim} />
          </XStack>
        </XStack>

        {/* Menu button */}
        <XStack alignSelf="center">
          <Popover open={menuOpen} onOpenChange={setMenuOpen} placement="bottom-end">
            <Popover.Trigger asChild>
              <XStack
                width={26}
                height={26}
                justifyContent="center"
                alignItems="center"
                opacity={0.4}
                hoverStyle={{ backgroundColor: TC.hoverBg, opacity: 0.8 }}
                borderRadius={4}
                cursor="pointer"
                marginRight={4}
              >
                <MoreVertical size={14} color={TC.iconDim} />
              </XStack>
            </Popover.Trigger>

            <Popover.Content
              backgroundColor={TC.menuBg}
              borderWidth={1}
              borderColor={TC.menuBorder}
              borderRadius={8}
              padding={4}
              elevate
              animation="quick"
              enterStyle={{ opacity: 0, y: -4 }}
              exitStyle={{ opacity: 0, y: -4 }}
            >
              <YStack minWidth={140}>
                {/* Split horizontal */}
                <XStack
                  paddingHorizontal={10}
                  paddingVertical={8}
                  gap={10}
                  alignItems="center"
                  borderRadius={4}
                  cursor="pointer"
                  hoverStyle={{ backgroundColor: TC.menuHover }}
                  onPress={() => {
                    splitContainer(container.id, "horizontal")
                    setMenuOpen(false)
                  }}
                >
                  <Columns size={14} color={TC.iconMid} />
                  <Text fontSize={12} color={c.text}>
                    {t('windows.splitHorizontal')}
                  </Text>
                </XStack>

                {/* Split vertical */}
                <XStack
                  paddingHorizontal={10}
                  paddingVertical={8}
                  gap={10}
                  alignItems="center"
                  borderRadius={4}
                  cursor="pointer"
                  hoverStyle={{ backgroundColor: TC.menuHover }}
                  onPress={() => {
                    splitContainer(container.id, "vertical")
                    setMenuOpen(false)
                  }}
                >
                  <Rows size={14} color={TC.iconMid} />
                  <Text fontSize={12} color={c.text}>
                    {t('windows.splitVertical')}
                  </Text>
                </XStack>

                <Separator marginVertical={4} backgroundColor={TC.menuSeparator} />

                {/* Close container */}
                <XStack
                  paddingHorizontal={10}
                  paddingVertical={8}
                  gap={10}
                  alignItems="center"
                  borderRadius={4}
                  cursor="pointer"
                  hoverStyle={{ backgroundColor: TC.menuHover }}
                  onPress={() => {
                    closeContainer(container.id)
                    setMenuOpen(false)
                  }}
                >
                  <Trash2 size={14} color={semanticColors.red} />
                  <Text fontSize={12} color={semanticColors.red}>
                    {t('windows.closePanel')}
                  </Text>
                </XStack>
              </YStack>
            </Popover.Content>
          </Popover>
        </XStack>
      </XStack>

      {/* Content */}
      <YStack
        flex={1}
        backgroundColor={colors.background}
        borderWidth={1}
        borderColor={colors.border}
        borderRadius={CONTENT_RADIUS}
        overflow="hidden"
        position="relative"
        zIndex={1}
        marginTop={0}
        data-content-area="true"
      >
        {containerWindows.length === 0 ? (
          <YStack flex={1} justifyContent="center" alignItems="center" gap={8}>
            <Text color={TC.emptyText} fontSize={12}>
              Empty pane
            </Text>
            <Text color={TC.emptySubtext} fontSize={10}>
              Drag a tab here
            </Text>
          </YStack>
        ) : (
          containerWindows.map((win) => {
            const isTabActive = win.id === container.activeWindowId
            const tabCtxValue: TabContextValue = {
              tabBgColor: colors.background,
              isContainerActive: isActive,
              isTabActive,
            }
            return (
              <TabContext.Provider key={win.id} value={tabCtxValue}>
                <YStack
                  flex={1}
                  display={isTabActive ? "flex" : "none"}
                >
                  <WindowContent
                    window={{
                      id: win.id,
                      type: win.type,
                      props: win.props,
                      mode: "docked",
                      isMinimized: false,
                      isMaximized: false,
                      hasNotification: win.hasNotification,
                      notificationCount: win.notificationCount,
                      createdAt: 0,
                      isPinned: false,
                    }}
                  />
                </YStack>
              </TabContext.Provider>
            )
          })
        )}
      </YStack>

      {/* Drop zone indicators */}
      {renderDropZoneIndicators()}
    </YStack>
  )
}

// ============================================
// TAB DROP INDICATOR
// ============================================

function TabDropIndicator() {
  return (
    <YStack
      width={3}
      height={28}
      backgroundColor={semanticColors.indigo}
      borderRadius={2}
      marginHorizontal={-1}
      alignSelf="center"
    />
  )
}

// ============================================
// CONCAVE CORNER (for active tab)
// ============================================

// ============================================
// DRAGGABLE TAB COMPONENT
// ============================================

interface DraggableTabProps {
  window: { id: string; type: string; props: Record<string, any>; hasNotification: boolean }
  containerId: string
  isActive: boolean
  isContainerActive: boolean
  onSelect: () => void
  onClose: () => void
  tabCount: number
}

// Max tab width, min tab width for Chrome-like behavior
const MAX_TAB_WIDTH = 180
const MIN_TAB_WIDTH = 60

function DraggableTab({
  window,
  containerId,
  isActive,
  isContainerActive,
  onSelect,
  onClose,
  tabCount,
}: DraggableTabProps) {
  const { startDrag, endDrag, isDragging } = useDragDrop()
  const [isDraggingThis, setIsDraggingThis] = useState(false)
  const c = useColors()
  const TC = buildTabColors(c)

  // Use shared hook for tab state
  const { Icon, iconColor, title, showSpinner, showRedDot, showBlueDot, showLock, showIcon } =
    useTabState(window, isActive)

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation()
      setIsDraggingThis(true)
      startDrag(window.id, containerId, title)

      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move"
        e.dataTransfer.setData("text/plain", window.id)

        // Custom ghost image
        const ghost = document.createElement('div')
        ghost.textContent = title
        ghost.style.cssText = [
          'position:absolute',
          'top:-1000px',
          'left:-1000px',
          `background:${TC.ghostBg}`,
          `border:1px solid ${TC.ghostBorder}`,
          'border-radius:8px',
          'padding:6px 12px',
          'font-size:12px',
          `color:${TC.ghostText}`,
          'white-space:nowrap',
          'pointer-events:none',
        ].join(';')
        document.body.appendChild(ghost)
        e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2)
        setTimeout(() => document.body.removeChild(ghost), 0)
      }
    },
    [window.id, containerId, title, startDrag],
  )

  const handleDragEnd = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation()
      setIsDraggingThis(false)
      endDrag()
    },
    [endDrag],
  )

  const handleClick = useCallback(
    (e: any) => {
      e.stopPropagation()
      if (!isDragging) {
        onSelect()
      }
    },
    [isDragging, onSelect],
  )

  const handleCloseClick = useCallback(
    (e: any) => {
      e.stopPropagation()
      onClose()
    },
    [onClose],
  )

  // Get colors based on state
  const colors = isContainerActive ? TC.active : TC.inactive

  // Active tab styling
  if (isActive) {
    return (
      <XStack
        data-tab="true"
        flex={1}
        maxWidth={MAX_TAB_WIDTH}
        minWidth={MIN_TAB_WIDTH}
        height={32}
        paddingHorizontal={10}
        paddingRight={4}
        gap={6}
        alignItems="center"
        backgroundColor={colors.background}
        borderTopLeftRadius={TAB_RADIUS}
        borderTopRightRadius={TAB_RADIUS}
        borderWidth={1}
        borderBottomWidth={0}
        borderColor={colors.border}
        marginLeft={4}
        marginRight={4}
        opacity={isDraggingThis ? 0.5 : 1}
        cursor="grab"
        position="relative"
        top={1}
        zIndex={3}
        onPress={handleClick}
        // @ts-expect-error - Web drag events
        draggable={Platform.OS === "web"}
        onDragStart={Platform.OS === "web" ? handleDragStart : undefined}
        onDragEnd={Platform.OS === "web" ? handleDragEnd : undefined}
      >
        {/* Concave corners */}
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

        {/* Status indicator — fixed-size wrapper prevents icon from shrinking */}
        {showSpinner && <View style={{ width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}><TerosLoading size={16} color={TC.dropAccent} /></View>}
        {showRedDot && <View style={{ width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}><Circle size={9} backgroundColor={semanticColors.red} /></View>}
        {showBlueDot && <View style={{ width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}><Circle size={9} backgroundColor={semanticColors.indigo} /></View>}
        {showLock && <View style={{ width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}><Lock size={14} color={TC.dropAccent} /></View>}
        {showIcon && Icon && <View style={{ width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}><Icon size={14} color={iconColor} /></View>}

        <Text flex={1} fontSize={12} color={colors.tabText} numberOfLines={1} pointerEvents="none">
          {title}
        </Text>

        <XStack
          width={24}
          height={24}
          borderRadius={4}
          justifyContent="center"
          alignItems="center"
          opacity={0.5}
          hoverStyle={{ backgroundColor: TC.closeHover, opacity: 1 }}
          onPress={handleCloseClick}
        >
          <X size={14} color={TC.iconDim} />
        </XStack>
      </XStack>
    )
  }

  // Inactive tab styling
  return (
    <XStack
      data-tab="true"
      flex={1}
      maxWidth={MAX_TAB_WIDTH}
      minWidth={MIN_TAB_WIDTH}
      height={32}
      paddingHorizontal={10}
      paddingRight={4}
      gap={6}
      alignItems="center"
      backgroundColor={TC.inactiveTab}
      borderTopLeftRadius={TAB_RADIUS}
      borderTopRightRadius={TAB_RADIUS}
      opacity={isDraggingThis ? 0.5 : 1}
      cursor="grab"
      hoverStyle={{ backgroundColor: TC.inactiveTabHover }}
      onPress={handleClick}
      // @ts-expect-error - Web drag events
      draggable={Platform.OS === "web"}
      onDragStart={Platform.OS === "web" ? handleDragStart : undefined}
      onDragEnd={Platform.OS === "web" ? handleDragEnd : undefined}
    >
      {/* Status indicator — fixed-size wrapper prevents icon from shrinking */}
      {showSpinner && <View style={{ width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}><TerosLoading size={16} color={TC.dropAccent} /></View>}
      {showRedDot && <View style={{ width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}><Circle size={9} backgroundColor={semanticColors.red} /></View>}
      {showBlueDot && <View style={{ width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}><Circle size={9} backgroundColor={semanticColors.indigo} /></View>}
      {showLock && <View style={{ width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}><Lock size={14} color={c.text3} /></View>}
      {showIcon && Icon && <View style={{ width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}><Icon size={14} color={iconColor} /></View>}

      <Text
        flex={1}
        fontSize={12}
        color={TC.inactiveTabText}
        numberOfLines={1}
        pointerEvents="none"
      >
        {title}
      </Text>

      <XStack
        width={24}
        height={24}
        borderRadius={4}
        justifyContent="center"
        alignItems="center"
        opacity={0.5}
        hoverStyle={{ backgroundColor: TC.closeHover, opacity: 1 }}
        onPress={handleCloseClick}
      >
        <X size={14} color={TC.iconDim} />
      </XStack>
    </XStack>
  )
}
