/**
 * TilingLayout - Renders the tiling layout tree
 *
 * Renderiza recursivamente splits y containers.
 * En mobile, usa MobileTilingLayout que consolida todas las tabs.
 */

import React, { useCallback, useState } from "react"
import { Platform, useWindowDimensions } from "react-native"
import { useTranslation } from "react-i18next"
import { XStack, YStack } from "tamagui"
import { Btn, T } from "../ui/ds"
import { NewConversationModal } from "../NewConversationModal"
import { type LayoutNode, type SplitNode, useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { DragDropProvider, type DropTarget } from "./DragDropContext"
import { FrameMelt } from "./FrameMelt"
import { useNavbarStore } from "../../store/navbarStore"
import { MobileTilingLayout } from "./MobileTilingLayout"
import { SplitHandle } from "./SplitHandle"
import { TilingContainer } from "./TilingContainer"
import { useColors } from "../mca/primitives/useColors"

const MOBILE_BREAKPOINT = 768

/**
 * TilingLayout - Wrapper que decide entre mobile y desktop
 */
export function TilingLayout() {
  const { width } = useWindowDimensions()
  const isMobile = width < MOBILE_BREAKPOINT

  // Render the appropriate component based on size
  // Cada uno tiene sus propios hooks internos
  if (isMobile) {
    return <MobileTilingLayout />
  }

  return <DesktopTilingLayout />
}

/**
 * DesktopTilingLayout - Layout de escritorio con splits
 */
function DesktopTilingLayout() {
  const c = useColors()
  const sidebarExpanded = useNavbarStore((st) => st.isExpanded)
  const layout = useTilingStore((state) => state.desktops[state.activeDesktopIndex]?.layout)
  const moveWindowToContainer = useTilingStore((state) => state.moveWindowToContainer)
  const moveWindowToNewSplit = useTilingStore((state) => state.moveWindowToNewSplit)

  const swapWindows = useTilingStore((state) => state.swapWindows)
  const floatWindow = useTilingStore((state) => state.floatWindow)
  const moveWindowsToContainer = useTilingStore((state) => state.moveWindowsToContainer)
  const moveWindowsToNewSplit = useTilingStore((state) => state.moveWindowsToNewSplit)
  const swapContainerWindows = useTilingStore((state) => state.swapContainerWindows)

  const handleDrop = useCallback(
    (
      windowId: string | null,
      windowIds: string[],
      sourceContainerId: string,
      target: DropTarget,
      isGroup: boolean,
    ) => {
      if (isGroup) {
        // Drag de grupo (todas las tabs)
        if (target.zone === "tabs") {
          moveWindowsToContainer(windowIds, target.containerId)
        } else if (target.zone === "center") {
          swapContainerWindows(sourceContainerId, target.containerId)
        } else if (target.zone === "left") {
          moveWindowsToNewSplit(windowIds, target.containerId, "horizontal", "before")
        } else if (target.zone === "right") {
          moveWindowsToNewSplit(windowIds, target.containerId, "horizontal", "after")
        } else if (target.zone === "bottom") {
          moveWindowsToNewSplit(windowIds, target.containerId, "vertical", "after")
        }
      } else if (windowId) {
        // Drag de una sola tab
        if (target.zone === "float") {
          floatWindow(windowId, { at: target.point })
        } else if (target.zone === "tabs") {
          moveWindowToContainer(windowId, target.containerId, target.tabIndex)
        } else if (target.zone === "center") {
          swapWindows(windowId, target.containerId)
        } else if (target.zone === "left") {
          moveWindowToNewSplit(windowId, target.containerId, "horizontal", "before")
        } else if (target.zone === "right") {
          moveWindowToNewSplit(windowId, target.containerId, "horizontal", "after")
        } else if (target.zone === "bottom") {
          moveWindowToNewSplit(windowId, target.containerId, "vertical", "after")
        }
      }
    },
    [
      floatWindow,
      moveWindowToContainer,
      moveWindowToNewSplit,
      swapWindows,
      moveWindowsToContainer,
      moveWindowsToNewSplit,
      swapContainerWindows,
    ],
  )

  // The frame melt belongs to the shell, not to a window: it shows on the
  // empty desktop too.
  const melt =
    sidebarExpanded && Platform.OS === "web" ? (
      <FrameMelt side="pane" frame={c.bgFrame} sheet={c.bgSheet} />
    ) : null

  if (!layout) {
    return (
      <YStack flex={1} backgroundColor={c.bgSheet} position="relative">
        <EmptyLayout />
        {melt}
      </YStack>
    )
  }

  return (
    <DragDropProvider onDrop={handleDrop}>
      {/* Wrapper — owns only the outer gap (4px to the sidebar's edge, 8px
          elsewhere). Each TilingContainer below is its OWN island (radius 8,
          overflow hidden, flush, no border): a lone pane reads as the window
          island; in a split, every pane floats individually with the canvas
          breathing in the corner notches beside the handle strip. No border
          anywhere — the window block is pure floating surface, not a framed box. */}
      <YStack flex={1} backgroundColor={c.bgSheet} position="relative">
        <LayoutNodeRenderer node={layout} />
        {/* The frame melt (web): the frame bulges into the first pane's left
            edge, flowing around cards, icons and text. */}
        {melt}
      </YStack>
    </DragDropProvider>
  )
}

/**
 * Renderiza un nodo del layout recursivamente
 */
function LayoutNodeRenderer({ node }: { node: LayoutNode }) {
  if (node.type === "container") {
    return <TilingContainer container={node} />
  }

  // Split node
  return <SplitRenderer split={node} />
}

/** Handle width/height in pixels — keep in sync with SplitHandle's size */
const HANDLE_SIZE = 8

/**
 * Renderiza un split con sus dos hijos y el handle
 */
function SplitRenderer({ split }: { split: SplitNode }) {
  const setRatio = useTilingStore((state) => state.setRatio)
  const isHorizontal = split.direction === "horizontal"

  // Usar ref para tener siempre el ratio actual
  const ratioRef = React.useRef(split.ratio)
  ratioRef.current = split.ratio

  const handleDrag = React.useCallback(
    (delta: number, totalSize: number) => {
      // totalSize includes the handle, so we subtract it for the calculation
      const availableSize = totalSize - HANDLE_SIZE
      const ratioDelta = delta / availableSize
      const newRatio = Math.max(0.1, Math.min(0.9, ratioRef.current + ratioDelta))
      setRatio(split.id, newRatio)
    },
    [split.id, setRatio],
  )

  const Container = isHorizontal ? XStack : YStack

  // Usar calc() para que los paneles ocupen exactamente el espacio disponible
  // minus the 12px handle, distributed according to the ratio
  // Ejemplo con ratio 0.5: primer panel = calc(50% - 6px), segundo = calc(50% - 6px)
  const firstSize = `calc(${split.ratio * 100}% - ${HANDLE_SIZE * split.ratio}px)`
  const secondSize = `calc(${(1 - split.ratio) * 100}% - ${HANDLE_SIZE * (1 - split.ratio)}px)`

  return (
    <Container flex={1}>
      {/* First child */}
      <YStack
        flexGrow={0}
        flexShrink={0}
        {...((isHorizontal
          ? { flexBasis: firstSize, minWidth: 100 }
          : { flexBasis: firstSize, minHeight: 100 }) as any)}
        overflow="visible"
      >
        <LayoutNodeRenderer node={split.first} />
      </YStack>

      {/* Split handle - fixed size */}
      <SplitHandle direction={split.direction} onDrag={handleDrag} />

      {/* Second child */}
      <YStack
        flexGrow={0}
        flexShrink={0}
        {...((isHorizontal
          ? { flexBasis: secondSize, minWidth: 100 }
          : { flexBasis: secondSize, minHeight: 100 }) as any)}
        overflow="visible"
      >
        <LayoutNodeRenderer node={split.second} />
      </YStack>
    </Container>
  )
}

/**
 * Empty state when there is no layout - shows actions to start.
 * When the empty desktop is removable (more than one desktop exists), a
 * "close desktop" affordance sits at the TOP RIGHT (Pablo, 30-oct): deleting
 * an EMPTY desktop is the safe, frequent case — it lives inside the desktop
 * view itself, not on the navbar dots.
 */
function EmptyLayout() {
  const c = useColors()
  const { t } = useTranslation()
  const { openWindow, openNewTab, desktops, removeDesktop } = useTilingStore()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const [showNewConversationModal, setShowNewConversationModal] = useState(false)

  // The last remaining desktop can never be removed (store rule, shown here
  // by simply not offering the affordance).
  const canCloseDesktop = desktops.length > 1

  const handleSelectAgent = (agent: { agentId: string; name: string; fullName: string }) => {
    openWindow(
      "chat",
      {
        agentId: agent.agentId,
        agentName: agent.name || agent.fullName,
        workspaceId: activeWorkspaceId ?? undefined,
      },
      true,
    )
  }

  return (
    <YStack
      flex={1}
      justifyContent="center"
      alignItems="center"
      backgroundColor={c.bgSheet}
      gap={18}
      padding={24}
      position="relative"
    >
      {/* Close desktop (top right) — only when other desktops remain. An
          empty desktop is safe to delete: no windows to migrate, nothing
          lost. Ghost button (quiet — the safe action), readable dark+light. */}
      {canCloseDesktop && (
        <Btn
          variant="ghost"
          size="sm"
          icon="x"
          testID="empty-desktop-close"
          style={{ position: "absolute", top: 16, right: 16 }}
          onPress={() => removeDesktop(useTilingStore.getState().activeDesktopIndex)}
        >
          {t("windows.closeDesktop", { defaultValue: "Cerrar desktop" })}
        </Btn>
      )}
      <T step="xs" tone="accent">
        Teros
      </T>
      <T step="3xl" center>
        {t("windows.emptyTitle", { defaultValue: "¿Qué abrimos?" })}
      </T>
      <T step="lg" tone="text2" center style={{ maxWidth: 480 }}>
        {t("windows.emptyLead", {
          defaultValue: "Empieza un chat con un agente o abre una ventana desde el launcher.",
        })}
      </T>
      <XStack gap={10} marginTop={8} flexWrap="wrap" justifyContent="center">
        <Btn
          variant="primary"
          size="lg"
          icon="chat-circle"
          onPress={() => setShowNewConversationModal(true)}
        >
          {t("nav.newChat", { defaultValue: "Nuevo chat" })}
        </Btn>
        <Btn
          variant="sec"
          size="lg"
          icon="squares-four"
          onPress={() => openNewTab()}
        >
          {t("windows.openLauncher", { defaultValue: "Abrir launcher" })}
        </Btn>
      </XStack>

      <NewConversationModal
        visible={showNewConversationModal}
        onClose={() => setShowNewConversationModal(false)}
        onSelectAgent={handleSelectAgent}
      />
    </YStack>
  )
}
