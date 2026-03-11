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
import { Circle, Popover, Separator, Text, XStack, YStack } from "tamagui"
import { useTabState } from "../../hooks/useTabState"
import { windowRegistry } from "../../services/windowRegistry"
import {
  type ContainerNode,
  selectActiveContainerId,
  useTilingStore,
} from "../../store/tilingStore"
import { TerosLoading } from "../TerosLoading"
import { type DropZone, useDragDrop } from "./DragDropContext"
import { WindowContent } from "./WindowContent"

interface Props {
  container: ContainerNode
}

// Size of the drop zones at the edges (in pixels)
const DROP_ZONE_SIZE = 60

// Design tokens
const TAB_RADIUS = 12
const CONTENT_RADIUS = 4
const COLORS = {
  active: {
    border: "#444",
    background: "#111113",
    tabText: "#e4e4e7",
  },
  inactive: {
    border: "#222",
    background: "#0a0a0b",
    tabText: "#aaa",
  },
  tabBar: "#080809",
  inactiveTab: "#0e0e10",
  inactiveTabText: "#555",
}

export function TilingContainer({ container }: Props) {
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

  const colors = isActive ? COLORS.active : COLORS.inactive

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
            backgroundColor="rgba(6, 182, 212, 0.2)"
            borderWidth={2}
            borderColor="#06B6D4"
            borderRadius={6}
            justifyContent="center"
            alignItems="center"
            pointerEvents="none"
            zIndex={100}
          >
            <Columns size={24} color="#06B6D4" />
            <Text color="#06B6D4" fontSize={11} marginTop={4}>
              Split izquierda
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
            backgroundColor="rgba(6, 182, 212, 0.2)"
            borderWidth={2}
            borderColor="#06B6D4"
            borderRadius={6}
            justifyContent="center"
            alignItems="center"
            pointerEvents="none"
            zIndex={100}
          >
            <Columns size={24} color="#06B6D4" />
            <Text color="#06B6D4" fontSize={11} marginTop={4}>
              Split derecha
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
            backgroundColor="rgba(6, 182, 212, 0.2)"
            borderWidth={2}
            borderColor="#06B6D4"
            borderRadius={6}
            justifyContent="center"
            alignItems="center"
            pointerEvents="none"
            zIndex={100}
          >
            <Rows size={24} color="#06B6D4" />
            <Text color="#06B6D4" fontSize={11} marginTop={4}>
              Split abajo
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
            backgroundColor="rgba(6, 182, 212, 0.15)"
            borderWidth={2}
            borderColor="rgba(6, 182, 212, 0.5)"
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
            backgroundColor="rgba(6, 182, 212, 0.15)"
            borderWidth={2}
            borderColor="rgba(6, 182, 212, 0.5)"
            borderRadius={6}
            justifyContent="center"
            alignItems="center"
            pointerEvents="none"
            zIndex={100}
          >
            <XStack gap={8} alignItems="center">
              <Text color="#06B6D4" fontSize={18}>
                ⇄
              </Text>
              <Text color="#06B6D4" fontSize={12} fontWeight="600">
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
        backgroundColor={COLORS.tabBar}
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
            containerWindows.length > 0 ? { backgroundColor: "#1a1a1a", opacity: 0.8 } : {}
          }
          alignSelf="center"
          // @ts-expect-error - Web drag events
          draggable={Platform.OS === "web" && containerWindows.length > 0}
          onDragStart={Platform.OS === "web" ? handleGripDragStart : undefined}
          onDragEnd={Platform.OS === "web" ? handleGripDragEnd : undefined}
        >
          <GripVertical size={14} color="#aaa" />
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
            hoverStyle={canGoBack ? { backgroundColor: "#1a1a1a", opacity: 1 } : {}}
            onPress={canGoBack && activeWindow ? () => navigateBack(activeWindow.id) : undefined}
          >
            <ChevronLeft size={14} color="#aaa" />
          </XStack>
          <XStack
            width={24}
            height={24}
            justifyContent="center"
            alignItems="center"
            borderRadius={4}
            opacity={canGoForward ? 0.7 : 0.2}
            cursor={canGoForward ? "pointer" : "default"}
            hoverStyle={canGoForward ? { backgroundColor: "#1a1a1a", opacity: 1 } : {}}
            onPress={canGoForward && activeWindow ? () => navigateForward(activeWindow.id) : undefined}
          >
            <ChevronRight size={14} color="#aaa" />
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
        </XStack>

        {/* Launcher button (+) */}
        <XStack
          alignSelf="center"
          width={26}
          height={26}
          justifyContent="center"
          alignItems="center"
          opacity={0.4}
          hoverStyle={{ backgroundColor: "#1a1a1a", opacity: 0.8 }}
          borderRadius={4}
          cursor="pointer"
          onPress={() => openWindow("launcher", {}, true, activeWindow?.id)}
        >
          <Plus size={14} color="#aaa" />
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
                hoverStyle={{ backgroundColor: "#1a1a1a", opacity: 0.8 }}
                borderRadius={4}
                cursor="pointer"
                marginRight={4}
              >
                <MoreVertical size={14} color="#aaa" />
              </XStack>
            </Popover.Trigger>

            <Popover.Content
              backgroundColor="#151515"
              borderWidth={1}
              borderColor="#2a2a2a"
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
                  hoverStyle={{ backgroundColor: "#1f1f1f" }}
                  onPress={() => {
                    splitContainer(container.id, "horizontal")
                    setMenuOpen(false)
                  }}
                >
                  <Columns size={14} color="#888" />
                  <Text fontSize={12} color="#ccc">
                    Split horizontal
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
                  hoverStyle={{ backgroundColor: "#1f1f1f" }}
                  onPress={() => {
                    splitContainer(container.id, "vertical")
                    setMenuOpen(false)
                  }}
                >
                  <Rows size={14} color="#888" />
                  <Text fontSize={12} color="#ccc">
                    Split vertical
                  </Text>
                </XStack>

                <Separator marginVertical={4} backgroundColor="#2a2a2a" />

                {/* Close container */}
                <XStack
                  paddingHorizontal={10}
                  paddingVertical={8}
                  gap={10}
                  alignItems="center"
                  borderRadius={4}
                  cursor="pointer"
                  hoverStyle={{ backgroundColor: "#1f1f1f" }}
                  onPress={() => {
                    closeContainer(container.id)
                    setMenuOpen(false)
                  }}
                >
                  <Trash2 size={14} color="#ef4444" />
                  <Text fontSize={12} color="#ef4444">
                    Cerrar panel
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
            <Text color="#333" fontSize={12}>
              Empty pane
            </Text>
            <Text color="#444" fontSize={10}>
              Drag a tab here
            </Text>
          </YStack>
        ) : (
          containerWindows.map((win) => (
            <YStack
              key={win.id}
              flex={1}
              // @ts-expect-error - display:none keeps the component mounted without unmounting
              display={win.id === container.activeWindowId ? "flex" : "none"}
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
          ))
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
      backgroundColor="#06B6D4"
      borderRadius={2}
      marginHorizontal={-1}
      alignSelf="center"
    />
  )
}

// ============================================
// CONCAVE CORNER (for active tab)
// ============================================

interface ConcaveCornerProps {
  side: "left" | "right"
  borderColor: string
  backgroundColor: string
}

function ConcaveCorner({ side, borderColor, backgroundColor }: ConcaveCornerProps) {
  // Using radial gradient to create concave corner effect
  const gradientPosition = side === "left" ? "0 0" : "100% 0"

  return (
    <View
      style={{
        position: "absolute",
        [side]: -TAB_RADIUS,
        bottom: 0,
        width: TAB_RADIUS,
        height: TAB_RADIUS,
        // @ts-expect-error - web style
        background: `radial-gradient(circle at ${gradientPosition}, transparent ${TAB_RADIUS - 1}px, ${borderColor} ${TAB_RADIUS - 1}px, ${borderColor} ${TAB_RADIUS}px, ${backgroundColor} ${TAB_RADIUS}px)`,
      }}
    />
  )
}

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
  const colors = isContainerActive ? COLORS.active : COLORS.inactive

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

        {/* Status indicator */}
        {showSpinner && <TerosLoading size={16} color="#06B6D4" />}
        {showRedDot && <Circle size={9} backgroundColor="#ef4444" />}
        {showBlueDot && <Circle size={9} backgroundColor="#06B6D4" />}
        {showLock && <Lock size={14} color="#06B6D4" />}
        {showIcon && Icon && <Icon size={14} color={iconColor} />}

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
          hoverStyle={{ backgroundColor: "#333", opacity: 1 }}
          onPress={handleCloseClick}
        >
          <X size={14} color="#aaa" />
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
      backgroundColor={COLORS.inactiveTab}
      borderTopLeftRadius={TAB_RADIUS}
      borderTopRightRadius={TAB_RADIUS}
      opacity={isDraggingThis ? 0.5 : 1}
      cursor="grab"
      hoverStyle={{ backgroundColor: "#151515" }}
      onPress={handleClick}
      // @ts-expect-error - Web drag events
      draggable={Platform.OS === "web"}
      onDragStart={Platform.OS === "web" ? handleDragStart : undefined}
      onDragEnd={Platform.OS === "web" ? handleDragEnd : undefined}
    >
      {/* Status indicator */}
      {showSpinner && <TerosLoading size={16} color="#06B6D4" />}
      {showRedDot && <Circle size={9} backgroundColor="#ef4444" />}
      {showBlueDot && <Circle size={9} backgroundColor="#06B6D4" />}
      {showLock && <Lock size={14} color="#666" />}
      {showIcon && Icon && <Icon size={14} color={iconColor} />}

      <Text
        flex={1}
        fontSize={12}
        color={COLORS.inactiveTabText}
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
        hoverStyle={{ backgroundColor: "#333", opacity: 1 }}
        onPress={handleCloseClick}
      >
        <X size={14} color="#aaa" />
      </XStack>
    </XStack>
  )
}
