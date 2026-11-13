/**
 * MobileTilingLayout — the phone shell of the OS prototype (design-testing).
 *
 * On mobile we consolidate every tab from every container into one strip:
 *   top bar   ☰ · Teros · (pending approvals) · agent pill · new chat
 *   tab strip ‹ › · pill tabs · ⌂ · ⋯
 *   content   the active window, full width, on the sheet
 */

import React, { useCallback, useEffect, useMemo, useState } from "react"
import { Platform, Pressable, ScrollView } from "react-native"
import { useTranslation } from "react-i18next"
import { LinearGradient } from "expo-linear-gradient"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Text, XStack, YStack } from "tamagui"
import { useTabState } from "../../hooks/useTabState"
import { useNavbarStore } from "../../store/navbarStore"
import { type ContainerNode, type LayoutNode, useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { NewConversationModal } from "../NewConversationModal"
import { PermissionIndicator } from "../navbar/PermissionIndicator"
import { TerosLogo } from "../TerosLogo"
import { useColors } from "../mca/primitives/useColors"
import { Btn, CountPill, IconBtn, Ph, T } from "../ui/ds"
import { WindowContent } from "./WindowContent"
import { requestCloseWindow } from "./windowClose"
import { TabStatusSlot } from "./TabStatusSlot"
import { TabMarks, TabTitleInput, WindowMenuButton, WindowRing } from "./WindowChrome"
import { useWindowChromeOf } from "../../store/windowChromeStore"

/** Collect all windows from all containers in the layout tree */
function collectAllWindows(node: LayoutNode | null): string[] {
  if (!node) return []
  if (node.type === "container") return node.windowIds
  return [...collectAllWindows(node.first), ...collectAllWindows(node.second)]
}

/** Find the container that has a specific window */
export function findContainerForWindow(
  node: LayoutNode | null,
  windowId: string,
): ContainerNode | null {
  if (!node) return null
  if (node.type === "container") return node.windowIds.includes(windowId) ? node : null
  return (
    findContainerForWindow(node.first, windowId) || findContainerForWindow(node.second, windowId)
  )
}

export function MobileTilingLayout() {
  const c = useColors()
  const insets = useSafeAreaInsets()
  const { t } = useTranslation()

  const windows = useTilingStore((state) => state.windows)
  const activeDesktop = useTilingStore((state) => state.desktops[state.activeDesktopIndex])
  const focusWindow = useTilingStore((state) => state.focusWindow)
  const openWindow = useTilingStore((state) => state.openWindow)
  const openNewTab = useTilingStore((state) => state.openNewTab)
  const navigateBack = useTilingStore((state) => state.navigateBack)
  const navigateForward = useTilingStore((state) => state.navigateForward)
  const pinWindow = useTilingStore((state) => state.pinWindow)
  const setCompactShell = useTilingStore((state) => state.setCompactShell)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const { setMobileMenuOpen } = useNavbarStore()

  const layout = activeDesktop?.layout
  const activeContainerId = activeDesktop?.activeContainerId

  const [showNewConversationModal, setShowNewConversationModal] = useState(false)

  // Preview windows (docs/specs/ui/preview-tabs.md) are pushed as a new
  // screen in the caller's pane while this compact shell is mounted.
  useEffect(() => {
    setCompactShell(true)
    return () => setCompactShell(false)
  }, [setCompactShell])

  const allWindowIds = useMemo(() => collectAllWindows(layout), [layout])
  const allWindows = useMemo(
    () => allWindowIds.map((id) => windows[id]).filter(Boolean),
    [allWindowIds, windows],
  )

  const activeWindow = useMemo(() => {
    if (!layout) return null
    const findActiveWindow = (node: LayoutNode): string | null => {
      if (node.type === "container")
        return node.id === activeContainerId ? node.activeWindowId : null
      return findActiveWindow(node.first) || findActiveWindow(node.second)
    }
    const activeWindowId = findActiveWindow(layout)
    return activeWindowId ? windows[activeWindowId] : allWindows[0] || null
  }, [layout, activeContainerId, windows, allWindows])

  const handleTabPress = useCallback((windowId: string) => focusWindow(windowId), [focusWindow])
  const handleCloseTab = useCallback((windowId: string) => requestCloseWindow(windowId), [])
  const handleOpenLauncher = useCallback(() => openNewTab(), [openNewTab])

  const handleSelectAgent = (agent: { agentId: string; name: string; fullName: string }) => {
    // Preview routing (preview-tabs.md): on the compact shell the preview
    // pushes in the source pane with a back caret — not a separate tab.
    openWindow(
      "chat",
      {
        agentId: agent.agentId,
        agentName: agent.name || agent.fullName,
        workspaceId: activeWorkspaceId ?? undefined,
      },
      false,
    )
  }

  // A window pushed from another one (preview) goes back to its opener: the
  // phone reads as stacked screens (list → detail ‹ back).
  const opener = activeWindow?.openerId ? windows[activeWindow.openerId] : undefined
  const canGoBack = activeWindow ? Boolean(opener) || (activeWindow.historyIndex ?? 0) > 0 : false
  const goBack = useCallback(() => {
    if (!activeWindow) return
    if (opener) focusWindow(opener.id)
    else navigateBack(activeWindow.id)
  }, [activeWindow, opener, focusWindow, navigateBack])
  const canGoForward = activeWindow
    ? (activeWindow.historyIndex ?? 0) < (activeWindow.history?.length ?? 1) - 1
    : false

  const empty = !layout || allWindows.length === 0
  const activeChrome = useWindowChromeOf(activeWindow?.id)

  return (
    <YStack flex={1} backgroundColor={c.bgFrame}>
      {/* One bar (44px + inset): menu · ‹ › · tabs · approvals · new chat —
          the previous two-row chrome read as too heavy on a phone. */}
      <XStack
        height={44 + insets.top}
        paddingTop={insets.top}
        alignItems="center"
        paddingLeft={6}
        paddingRight={8}
        gap={2}
      >
        <IconBtn
          icon="list"
          plain
          onPress={() => setMobileMenuOpen(true)}
          title={t("nav.menu", { defaultValue: "Menú" })}
        />
        {!empty ? (
          <>
            <IconBtn
              icon="caret-left"
              plain
              sm
              disabled={!canGoBack}
              onPress={canGoBack ? goBack : undefined}
            />
            <IconBtn
              icon="caret-right"
              plain
              sm
              disabled={!canGoForward}
              onPress={
                canGoForward && activeWindow ? () => navigateForward(activeWindow.id) : undefined
              }
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flex: 1 }}
              contentContainerStyle={{ alignItems: "center", gap: 4, paddingHorizontal: 4 }}
            >
              {allWindows.map((window) => (
                <MobileTab
                  key={window.id}
                  window={window}
                  isActive={activeWindow?.id === window.id}
                  onSelect={() => handleTabPress(window.id)}
                  onClose={() => handleCloseTab(window.id)}
                  onPin={() => pinWindow(window.id)}
                />
              ))}
            </ScrollView>
            <IconBtn icon="plus" plain sm onPress={handleOpenLauncher} />
            {activeWindow ? <WindowMenuButton window={activeWindow} /> : null}
          </>
        ) : (
          <XStack flex={1} alignItems="center" gap={8} paddingLeft={4}>
            <TerosLogo size={20} animated={false} />
            <T step="base">Teros</T>
          </XStack>
        )}
        <PermissionIndicator collapsed />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("nav.newChat", { defaultValue: "Nuevo chat" })}
          onPress={() => setShowNewConversationModal(true)}
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            backgroundColor: c.inkPill,
            alignItems: "center",
            justifyContent: "center",
            marginLeft: 4,
          }}
        >
          <Ph name="pencil-simple-line" size={15} color={c.inkPillText} />
        </Pressable>
      </XStack>

      {/* The sheet — runs to the screen's bottom edge and owns the safe
          zone: content keeps the inset as padding, and a fade (like the
          sidebar's scroll fades) turns the sheet into the frame colour over
          the home-indicator band, so there is no white step and no grey
          strip. */}
      <YStack
        flex={1}
        backgroundColor={c.bgSheet}
        borderTopLeftRadius={16}
        borderTopRightRadius={16}
        overflow="hidden"
        paddingBottom={insets.bottom}
        position="relative"
      >
        {!empty && activeChrome.ring ? <WindowRing line /> : null}
        {insets.bottom > 0 ? (
          <LinearGradient
            colors={["transparent", c.bgFrame]}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: insets.bottom + 28,
              zIndex: 10,
            }}
            pointerEvents="none"
          />
        ) : null}
        {empty ? (
          <YStack flex={1} justifyContent="center" alignItems="center" gap={14} padding={24}>
            <T step="xs" tone="accent">
              Teros
            </T>
            <T step="3xl" center>
              {t("windows.emptyTitle", { defaultValue: "¿Qué abrimos?" })}
            </T>
            <T step="base" tone="text2" center>
              {t("windows.emptyLead", {
                defaultValue: "Empieza un chat con un agente o abre una ventana desde el launcher.",
              })}
            </T>
            <YStack gap={10} marginTop={6} alignSelf="stretch" alignItems="center">
              <Btn
                variant="primary"
                size="lg"
                icon="chat-circle"
                onPress={() => setShowNewConversationModal(true)}
              >
                {t("nav.newChat", { defaultValue: "Nuevo chat" })}
              </Btn>
              <Btn variant="sec" size="lg" icon="squares-four" onPress={handleOpenLauncher}>
                {t("windows.openLauncher", { defaultValue: "Abrir launcher" })}
              </Btn>
            </YStack>
          </YStack>
        ) : (
          <>
            {/* Content */}
            <YStack flex={1} backgroundColor={c.bgSheet}>
              {activeWindow && (
                <WindowContent
                  key={activeWindow.id}
                  window={{
                    id: activeWindow.id,
                    type: activeWindow.type,
                    props: activeWindow.props,
                    mode: "docked",
                    isMinimized: false,
                    isMaximized: false,
                    hasNotification: activeWindow.hasNotification,
                    notificationCount: activeWindow.notificationCount,
                    createdAt: Date.now(),
                    isPinned: false,
                  }}
                />
              )}
            </YStack>
          </>
        )}
      </YStack>

      <NewConversationModal
        visible={showNewConversationModal}
        onClose={() => setShowNewConversationModal(false)}
        onSelectAgent={handleSelectAgent}
      />
    </YStack>
  )
}

// ============================================
// MOBILE TAB (`.wtab`, pill)
// ============================================

interface MobileTabProps {
  window: {
    id: string
    type: string
    props: Record<string, any>
    hasNotification: boolean
    notificationCount?: number
    preview?: boolean
  }
  isActive: boolean
  onSelect: () => void
  onClose: () => void
  onPin: () => void
}

function MobileTab({ window, isActive, onSelect, onClose, onPin }: MobileTabProps) {
  const c = useColors()
  const tabState = useTabState(window, isActive)
  const { title } = tabState
  const isPreview = Boolean(window.preview)

  const handleCloseClick = useCallback(
    (e: any) => {
      e.stopPropagation()
      onClose()
    },
    [onClose],
  )

  const fg = isActive ? (isPreview ? c.text2 : c.text) : c.text3
  const glyph = isActive ? c.accent : c.text3

  return (
    <XStack
      height={32}
      paddingLeft={10}
      paddingRight={isActive ? 4 : 10}
      gap={6}
      alignItems="center"
      backgroundColor={isActive ? c.navActive : "transparent"}
      borderRadius={10}
      cursor="pointer"
      pressStyle={{ backgroundColor: c.wash2 }}
      onPress={onSelect}
    >
      <TabStatusSlot state={tabState} glyph={glyph} />
      {isActive && tabState.chrome?.titleEdit ? (
        <XStack width={140}>
          <TabTitleInput edit={tabState.chrome.titleEdit} />
        </XStack>
      ) : (
        <Text fontSize={13} fontFamily="Saans" color={fg} numberOfLines={1} maxWidth={140}>
          {title}
        </Text>
      )}
      <TabMarks marks={tabState.chrome?.marks} color={c.text3} compact />
      {!isActive && window.hasNotification && (window.notificationCount ?? 0) > 0 ? (
        <CountPill n={window.notificationCount!} />
      ) : null}
      {isActive && isPreview ? (
        <XStack
          width={24}
          height={24}
          borderRadius={6}
          justifyContent="center"
          alignItems="center"
          opacity={0.6}
          pressStyle={{ opacity: 1 }}
          onPress={(e: any) => {
            e?.stopPropagation?.()
            onPin()
          }}
          accessibilityRole="button"
          accessibilityLabel="Pin tab"
        >
          <Ph name="push-pin" size={12} color={fg} />
        </XStack>
      ) : null}
      {isActive ? (
        <XStack
          width={24}
          height={24}
          borderRadius={6}
          justifyContent="center"
          alignItems="center"
          opacity={0.6}
          pressStyle={{ opacity: 1 }}
          onPress={handleCloseClick}
          accessibilityRole="button"
          accessibilityLabel="Close tab"
        >
          <Ph name="x" size={12} color={fg} />
        </XStack>
      ) : null}
    </XStack>
  )
}

// Platform guard kept for parity with the desktop container (web-only hover styles).
void Platform
