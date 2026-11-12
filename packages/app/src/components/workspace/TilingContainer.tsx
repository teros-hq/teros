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

import { Columns, Rows } from "@tamagui/lucide-icons"
import React, { useCallback, useEffect, useRef, useState } from "react"
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  View,
} from "react-native"
import { useTranslation } from "react-i18next"
import { Circle, Popover, Separator, Text, XStack, YStack } from "tamagui"
import { LinearGradient } from "expo-linear-gradient"
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
import { useAwakeTabs } from "./useAwakeTabs"
import { TabContext, type TabContextValue } from "./TabContext"
import { buildTabColors } from "./tabColors"
import { CountPill, Ph, WorkingDot } from "../ui/ds"

interface Props {
  container: ContainerNode
}

// Size of the drop zones at the edges (in pixels)
const DROP_ZONE_SIZE = 120

export function TilingContainer({ container }: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const TC = buildTabColors(c)
  const [tabDropIndex, setTabDropIndex] = useState<number | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // Horizontal overflow of the tab row — drives the edge fade indicators
  // (same pattern as the navbar's vertical scroll gradients): a fade shows
  // on a side only while there are more tabs that way.
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const tabBarRef = useRef<HTMLDivElement | null>(null)
  // The element that actually scrolls horizontally (the tabs ScrollView) —
  // distinct from tabBarRef (the whole strip), which the drop-indicator
  // math depends on.
  const tabScrollRef = useRef<HTMLDivElement | null>(null)

  const {
    windows,
    setActiveTab,
    focusContainer,
    closeWindow,
    splitContainer,
    closeContainer,
    openWindow,
    openNewTab,
    navigateBack,
    navigateForward,
    pinWindow,
  } = useTilingStore()

  // Use selectors for derived state from active desktop
  const activeContainerId = useTilingStore(selectActiveContainerId)

  // Drag & drop context
  const { dragState, dropTarget, startDrag, startGroupDrag, setDropTarget, endDrag, isDragging } =
    useDragDrop()

  const isActive = activeContainerId === container.id
  const containerWindows = container.windowIds.map((id) => windows[id]).filter(Boolean)
  const activeWindow = container.activeWindowId ? windows[container.activeWindowId] : null

  const isAwakeTab = useAwakeTabs(containerWindows, container.activeWindowId)

  const colors = isActive ? TC.active : TC.inactive

  // Back / forward navigation state for the active window
  const canGoBack = activeWindow ? (activeWindow.historyIndex ?? 0) > 0 : false
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

      // Effective drop zone size: 120px max, but never more than 40% of the container
      const hZone = Math.min(DROP_ZONE_SIZE, width * 0.4)
      const vZone = Math.min(DROP_ZONE_SIZE, height * 0.4)

      // Check border zones for splits, and center for swap
      let zone: DropZone | null = null

      if (x < hZone) {
        zone = "left"
      } else if (x > width - hZone) {
        zone = "right"
      } else if (y > height - vZone) {
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

  // Web: recompute the edge fades on every scroll and on tab-count changes
  // (adding/removing a tab can create or clear overflow on either side).
  const measureTabOverflow = useCallback(() => {
    const el = tabScrollRef.current
    if (!el) return
    const canLeft = el.scrollLeft > 4
    const canRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
    setTabOverflow((prev) =>
      prev.left === canLeft && prev.right === canRight ? prev : { left: canLeft, right: canRight },
    )
  }, [])

  const onTabRowScroll = useCallback(
    (_e: NativeSyntheticEvent<NativeScrollEvent>) => {
      measureTabOverflow()
    },
    [measureTabOverflow],
  )

  // Tab list changed — the row may now overflow (or stop overflowing) while
  // sitting at the same scrollLeft.
  useEffect(() => {
    measureTabOverflow()
  }, [containerWindows.length, measureTabOverflow])

  // Strip ref (the whole tab bar XStack) — the drop-indicator math reads its
  // rect and queries its [data-tab] children.
  const setTabBarRefCallback = useCallback((node: View | null) => {
    if (Platform.OS === "web" && node) {
      tabBarRef.current = node as unknown as HTMLDivElement
    }
  }, [])

  const setTabScrollRefCallback = useCallback(
    (node: View | null) => {
      if (Platform.OS === "web" && node) {
        tabScrollRef.current = node as unknown as HTMLDivElement
        // Measure once on mount — a tab row that already overflows shows its
        // edge fades without waiting for a scroll.
        measureTabOverflow()
      }
    },
    [measureTabOverflow],
  )

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
        const ghost = document.createElement("div")
        ghost.textContent = title
        ghost.style.cssText = [
          "position:absolute",
          "top:-1000px",
          "left:-1000px",
          `background:${TC.ghostBg}`,
          `border:1px solid ${TC.ghostBorder}`,
          "border-radius:8px",
          "padding:6px 12px",
          "font-size:12px",
          `color:${TC.ghostText}`,
          "white-space:nowrap",
          "pointer-events:none",
        ].join(";")
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
            top={44}
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
              {t("windows.splitLeft")}
            </Text>
          </YStack>
        )}

        {/* Right zone indicator */}
        {currentDropZone === "right" && (
          <YStack
            position="absolute"
            top={44}
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
              {t("windows.splitRight")}
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
              {t("windows.splitBottom")}
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
            height={44}
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
            top={44}
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
      // The pane of the unida frame: flush on the sheet, no radius, no border.
      // Panes in a split are separated by one hairline (`.win + .win`).
      backgroundColor={c.bgSheet}
      overflow="hidden"
      position="relative"
      onPress={handleContainerPress}
      {...webEventHandlers}
    >
      {/* Tab bar (`.tabbar`, pill tabs) */}
      <XStack
        ref={setTabBarRefCallback as any}
        height={44}
        alignItems="center"
        paddingLeft={6}
        paddingRight={8}
        position="relative"
        zIndex={2}
        overflow="visible"
      >
        {/* Grip — drags the whole tab group */}
        <XStack
          width={16}
          height={30}
          justifyContent="center"
          alignItems="center"
          opacity={containerWindows.length > 0 ? 0.7 : 0.25}
          cursor={containerWindows.length > 0 ? "grab" : "default"}
          // @ts-expect-error - Web drag events
          draggable={Platform.OS === "web" && containerWindows.length > 0}
          onDragStart={Platform.OS === "web" ? handleGripDragStart : undefined}
          onDragEnd={Platform.OS === "web" ? handleGripDragEnd : undefined}
        >
          <Ph name="dots-six-vertical" size={14} color={c.text3} />
        </XStack>

        {/* Back / forward (`.ctl`) */}
        <XStack alignItems="center" gap={2} height={30} marginRight={8}>
          <TabCtl
            icon="caret-left"
            disabled={!canGoBack}
            onPress={canGoBack && activeWindow ? () => navigateBack(activeWindow.id) : undefined}
          />
          <TabCtl
            icon="caret-right"
            disabled={!canGoForward}
            onPress={
              canGoForward && activeWindow ? () => navigateForward(activeWindow.id) : undefined
            }
          />
        </XStack>

        {/* Tabs — horizontal scroll when overflowing, pills with 4px gap */}
        <View style={{ flex: 1, position: "relative", minWidth: 0 }}>
          <ScrollView
            ref={setTabScrollRefCallback as any}
            onScroll={onTabRowScroll}
            scrollEventThrottle={16}
            style={{ flex: 1 }}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ alignItems: "center", gap: 4, paddingRight: 8 }}
          >
            {containerWindows.map((window, index) => (
              <React.Fragment key={window.id}>
                {tabDropIndex === index && currentDropZone === "tabs" && <TabDropIndicator />}
                <DraggableTab
                  window={window}
                  containerId={container.id}
                  isActive={container.activeWindowId === window.id}
                  isContainerActive={isActive}
                  onSelect={() => setActiveTab(container.id, window.id)}
                  onClose={() => closeWindow(window.id)}
                  onPin={() => pinWindow(window.id)}
                  tabCount={containerWindows.length}
                />
              </React.Fragment>
            ))}
            {tabDropIndex === containerWindows.length && currentDropZone === "tabs" && (
              <TabDropIndicator />
            )}
            {/* `.newtab` — opens the launcher next to the active window */}
            <XStack
              width={30}
              height={30}
              justifyContent="center"
              alignItems="center"
              borderRadius={8}
              marginLeft={4}
              cursor="pointer"
              hoverStyle={{ backgroundColor: c.wash }}
              pressStyle={{ scale: 0.96 }}
              accessibilityRole="button"
              accessibilityLabel="Open launcher - new window"
              onPress={() => openNewTab(activeWindow?.id)}
            >
              <Ph name="plus" size={14} color={c.text3} />
            </XStack>
          </ScrollView>

          {tabOverflow.left && (
            <LinearGradient
              colors={[c.bgSheet, "transparent"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 24, zIndex: 3 }}
              pointerEvents="none"
            />
          )}
          {tabOverflow.right && (
            <LinearGradient
              colors={["transparent", c.bgSheet]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 24, zIndex: 3 }}
              pointerEvents="none"
            />
          )}
        </View>

        {/* End tools (`.end`): split right + menu */}
        <XStack alignItems="center" gap={2} height={30} marginLeft={8}>
          <TabCtl
            icon="columns"
            size={28}
            title={t("windows.splitHorizontal")}
            onPress={() => splitContainer(container.id, "horizontal")}
          />
          <Popover open={menuOpen} onOpenChange={setMenuOpen} placement="bottom-end">
            <Popover.Trigger asChild>
              <XStack
                width={28}
                height={28}
                justifyContent="center"
                alignItems="center"
                borderRadius={100}
                cursor="pointer"
                hoverStyle={{ backgroundColor: c.wash }}
                accessibilityRole="button"
                accessibilityLabel="Window options menu"
              >
                <Ph name="dots-three-vertical" size={14} color={c.text3} />
              </XStack>
            </Popover.Trigger>

            <Popover.Content
              backgroundColor={c.bgStep}
              borderWidth={1}
              borderColor={c.border}
              borderRadius={16}
              padding={6}
              elevate
              animation="quick"
              enterStyle={{ opacity: 0, y: -4 }}
              exitStyle={{ opacity: 0, y: -4 }}
              {...(Platform.OS === "web" ? ({ style: { boxShadow: c.elevRaised } } as any) : {})}
            >
              <YStack minWidth={200}>
                {activeWindow?.preview ? (
                  <MenuItem
                    icon="push-pin"
                    label={t("windows.pinTab")}
                    onPress={() => {
                      pinWindow(activeWindow.id)
                      setMenuOpen(false)
                    }}
                  />
                ) : null}
                <MenuItem
                  icon="columns"
                  label={t("windows.splitHorizontal")}
                  onPress={() => {
                    splitContainer(container.id, "horizontal")
                    setMenuOpen(false)
                  }}
                />
                <MenuItem
                  icon="rows"
                  label={t("windows.splitVertical")}
                  onPress={() => {
                    splitContainer(container.id, "vertical")
                    setMenuOpen(false)
                  }}
                />
                <Separator marginVertical={6} marginHorizontal={4} backgroundColor={c.border} />
                <MenuItem
                  icon="trash"
                  label={t("windows.closePanel")}
                  danger
                  onPress={() => {
                    closeContainer(container.id)
                    setMenuOpen(false)
                  }}
                />
              </YStack>
            </Popover.Content>
          </Popover>
        </XStack>
      </XStack>

      {/* Content — the pane */}
      <YStack
        flex={1}
        backgroundColor={c.bgSheet}
        overflow="hidden"
        position="relative"
        zIndex={1}
        data-content-area="true"
      >
        {containerWindows.length === 0 ? (
          <YStack flex={1} justifyContent="center" alignItems="center" gap={8}>
            <Text color={c.text3} fontSize={13} fontFamily="Saans">
              {t("windows.emptyPane", { defaultValue: "Panel vacío" })}
            </Text>
            <Text color={c.text3} fontSize={11} fontFamily="Saans" opacity={0.7}>
              {t("windows.dragTabHere", { defaultValue: "Arrastra una pestaña aquí" })}
            </Text>
          </YStack>
        ) : (
          containerWindows.map((win) => {
            // TABH-REQ-1: a tab idle for HIBERNATE_AFTER_MS is unmounted; its tab-strip
            // entry, props and persisted layout are untouched (TABH-REQ-6).
            if (!isAwakeTab(win.id)) return null
            const isTabActive = win.id === container.activeWindowId
            const tabCtxValue: TabContextValue = {
              tabBgColor: c.bgSheet,
              isContainerActive: isActive,
              isTabActive,
            }
            return (
              <TabContext.Provider key={win.id} value={tabCtxValue}>
                <YStack flex={1} display={isTabActive ? "flex" : "none"}>
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
// TAB BAR CONTROLS
// ============================================

function TabCtl({
  icon,
  onPress,
  disabled,
  size = 22,
  title,
}: {
  icon: string
  onPress?: () => void
  disabled?: boolean
  size?: number
  title?: string
}) {
  const c = useColors()
  return (
    <XStack
      width={size}
      height={size}
      justifyContent="center"
      alignItems="center"
      borderRadius={size > 24 ? 100 : 6}
      opacity={disabled ? 0.35 : 1}
      cursor={disabled ? "default" : "pointer"}
      hoverStyle={disabled ? {} : { backgroundColor: c.wash }}
      pressStyle={disabled ? {} : { scale: 0.94 }}
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      {...(Platform.OS === "web" && title ? ({ title } as any) : {})}
    >
      <Ph name={icon} size={14} color={c.text3} />
    </XStack>
  )
}

function MenuItem({
  icon,
  label,
  onPress,
  danger,
}: {
  icon: string
  label: string
  onPress: () => void
  danger?: boolean
}) {
  const c = useColors()
  const fg = danger ? c.tint.r.tx : c.text
  return (
    <XStack
      paddingHorizontal={10}
      paddingVertical={8}
      gap={10}
      alignItems="center"
      borderRadius={10}
      cursor="pointer"
      hoverStyle={{ backgroundColor: c.wash }}
      onPress={onPress}
    >
      <Ph name={icon} size={14} color={danger ? c.tint.r.tx : c.text2} />
      <Text fontSize={13} color={fg} fontFamily="Saans">
        {label}
      </Text>
    </XStack>
  )
}

// ============================================
// TAB DROP INDICATOR
// ============================================

function TabDropIndicator() {
  return (
    <YStack
      width={3}
      height={24}
      backgroundColor={semanticColors.purple300}
      borderRadius={2}
      marginHorizontal={-1}
      alignSelf="center"
    />
  )
}

// ============================================
// DRAGGABLE TAB COMPONENT (`.wtab`, pill)
// ============================================

interface DraggableTabProps {
  window: { id: string; type: string; props: Record<string, any>; hasNotification: boolean; preview?: boolean }
  containerId: string
  isActive: boolean
  isContainerActive: boolean
  onSelect: () => void
  onClose: () => void
  /** Turn a preview tab into a pinned one (pin button, double-click). */
  onPin: () => void
  tabCount: number
}

// Max tab width, min tab width for Chrome-like behavior
const MAX_TAB_WIDTH = 200
const MIN_TAB_WIDTH = 72

function DraggableTab({
  window,
  containerId,
  isActive,
  isContainerActive,
  onSelect,
  onClose,
  onPin,
  tabCount,
}: DraggableTabProps) {
  const { t } = useTranslation()
  const { startDrag, endDrag, isDragging } = useDragDrop()
  const [isDraggingThis, setIsDraggingThis] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const c = useColors()
  const TC = buildTabColors(c)

  const { Icon, title, showSpinner, showRedDot, showBlueDot, showIcon, definition, meta } =
    useTabState(window, isActive)
  const phIcon = meta?.phIcon ?? ((definition as any)?.phIcon as string | undefined)
  const isPreview = Boolean(window.preview)

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation()
      setIsDraggingThis(true)
      startDrag(window.id, containerId, title)

      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move"
        e.dataTransfer.setData("text/plain", window.id)

        const ghost = document.createElement("div")
        ghost.textContent = title
        ghost.style.cssText = [
          "position:absolute",
          "top:-1000px",
          "left:-1000px",
          `background:${TC.ghostBg}`,
          `border:1px solid ${TC.ghostBorder}`,
          "border-radius:10px",
          "padding:6px 12px",
          "font-size:12px",
          "font-family:Saans, system-ui, sans-serif",
          `color:${TC.ghostText}`,
          "white-space:nowrap",
          "pointer-events:none",
        ].join(";")
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
      if (!isDragging) onSelect()
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

  const handlePinClick = useCallback(
    (e: any) => {
      e.stopPropagation()
      onPin()
    },
    [onPin],
  )

  const useFixedWidth = tabCount > 6
  // Active pill: nav-active wash + text; the glyph takes the accent. Inactive:
  // quiet text3, wash on hover. The active tab of a dormant pane keeps its
  // fill but not the accent glyph — the focus line on the pane says who leads.
  const on = isActive
  const bg = on ? c.navActive : isHovered ? c.wash : "transparent"
  // A preview tab (it follows a list's selection) reads one step greyer than a
  // pinned one and carries a pin; double-click or the pin keeps it.
  const fg = on ? (isPreview ? c.text2 : c.text) : c.text3
  const glyph = on && isContainerActive ? c.accent : c.text3

  const statusSlot = (
    <View
      style={{
        width: 16,
        height: 16,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {showSpinner && <TerosLoading size={14} color={TC.spinnerAccent} />}
      {showRedDot && <Circle size={8} backgroundColor={TC.redDot} />}
      {showBlueDot && <Circle size={8} backgroundColor={TC.blueDot} />}
      {showIcon &&
        (meta?.spinner && meta.dotColor ? (
          <WorkingDot size={8} color={meta.dotColor} />
        ) : meta?.dotColor ? (
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: meta.dotHollow ? "transparent" : meta.dotColor,
              borderWidth: meta.dotHollow ? 1.5 : 0,
              borderColor: meta.dotColor,
            }}
          />
        ) : phIcon ? (
          <Ph name={phIcon} size={14} color={glyph} />
        ) : Icon ? (
          <Icon size={14} color={glyph} />
        ) : null)}
    </View>
  )

  return (
    <XStack
      data-tab="true"
      {...({ "data-fx": isActive ? "tab-on" : undefined, "data-window-id": window.id } as unknown as Record<string, never>)}
      flex={useFixedWidth ? undefined : 1}
      width={useFixedWidth ? MAX_TAB_WIDTH : undefined}
      maxWidth={MAX_TAB_WIDTH}
      minWidth={MIN_TAB_WIDTH}
      height={30}
      paddingLeft={10}
      paddingRight={6}
      gap={7}
      alignItems="center"
      backgroundColor={bg}
      borderRadius={10}
      opacity={isDraggingThis ? 0.5 : 1}
      cursor="grab"
      position="relative"
      onPress={handleClick}
      accessibilityLabel={isPreview ? `${title} · ${t("windows.previewTab")}` : title}
      {...(Platform.OS === "web"
        ? {
            onMouseEnter: () => setIsHovered(true),
            onMouseLeave: () => setIsHovered(false),
            onDoubleClick: isPreview ? handlePinClick : undefined,
            title: isPreview ? t("windows.previewTabHint") : undefined,
            style: { transition: "background 0.2s, color 0.2s" },
          }
        : {})}
      // @ts-expect-error - Web drag events
      draggable={Platform.OS === "web"}
      onDragStart={Platform.OS === "web" ? handleDragStart : undefined}
      onDragEnd={Platform.OS === "web" ? handleDragEnd : undefined}
    >
      {statusSlot}
      <Text
        flex={1}
        fontSize={13}
        fontFamily="Saans"
        color={fg}
        numberOfLines={1}
        pointerEvents="none"
      >
        {title}
      </Text>
      {window.hasNotification &&
      !isActive &&
      typeof (window as any).notificationCount === "number" &&
      (window as any).notificationCount > 0 ? (
        <CountPill n={(window as any).notificationCount} />
      ) : null}
      {isPreview ? (
        <XStack
          width={20}
          height={20}
          borderRadius={6}
          justifyContent="center"
          alignItems="center"
          opacity={on ? 0.6 : isHovered ? 0.6 : 0}
          hoverStyle={{ backgroundColor: on ? "rgba(111,39,255,0.12)" : c.wash2, opacity: 1 }}
          onPress={handlePinClick}
          accessibilityRole="button"
          accessibilityLabel={t("windows.pinTab")}
        >
          <Ph name="push-pin" size={12} color={fg} />
        </XStack>
      ) : null}
      <XStack
        width={20}
        height={20}
        borderRadius={6}
        justifyContent="center"
        alignItems="center"
        opacity={on ? 0.6 : isHovered ? 0.8 : 0}
        hoverStyle={{ backgroundColor: on ? "rgba(111,39,255,0.12)" : c.wash2, opacity: 1 }}
        onPress={handleCloseClick}
        accessibilityRole="button"
        accessibilityLabel="Close tab"
      >
        <Ph name="x" size={12} color={fg} />
      </XStack>
    </XStack>
  )
}
