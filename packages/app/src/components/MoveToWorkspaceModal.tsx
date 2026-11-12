/**
 * MoveToWorkspaceModal — Reusable workspace selector dialog
 *
 * Shows a list of the user's workspaces (excluding the current one) and moves
 * the given conversation to the selected workspace via channel.moveToWorkspace.
 *
 * Used by:
 * - ConversationsWindowContent (conversation list)
 * - ChatView / ChatHeader (open chat window)
 *
 * Styled as an OS-prototype sheet: step card radius 16, serif title, sans
 * lead, workspaces as an LGroup of hover rows with a tile glyph, ghost cancel.
 */

import React, { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ScrollView, View } from "react-native"
import { Dialog } from "tamagui"
import { getTerosClient } from "../services/terosClientSingleton"
import { useWorkspaceStore } from "../store/workspaceStore"
import { useColors } from "./mca/primitives/useColors"
import { useToast } from "./Toast"
import { AppSpinner } from "./ui"
import { Btn, LGroup, LRow, Ph, T, Tile } from "./ui/ds"

interface MoveToWorkspaceModalProps {
  /** Channel ID of the conversation to move */
  channelId: string | null
  /** Whether the modal is visible */
  visible: boolean
  /** Called when the modal should close */
  onClose: () => void
  /** Called after a successful move (e.g. to close the chat window or remove from list) */
  onMoved?: (targetWorkspaceId: string) => void
}

export function MoveToWorkspaceModal({
  channelId,
  visible,
  onClose,
  onMoved,
}: MoveToWorkspaceModalProps) {
  const { t } = useTranslation()
  const c = useColors()
  const toast = useToast()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  const [workspaces, setWorkspaces] = useState<Array<{ workspaceId: string; name: string }>>([])
  const [isMovingWorkspace, setIsMovingWorkspace] = useState(false)
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(false)

  // Load workspaces when the modal opens
  useEffect(() => {
    if (!visible) return
    setIsLoadingWorkspaces(true)
    getTerosClient()
      .workspace.listWorkspaces()
      .then(({ workspaces: wsList }) => {
        setWorkspaces(wsList)
      })
      .catch((err) => {
        console.error("[MoveToWorkspaceModal] Error loading workspaces:", err)
        setWorkspaces([])
        toast.error(t("conversations.moveToWorkspaceError"))
      })
      .finally(() => {
        setIsLoadingWorkspaces(false)
      })
  }, [visible])

  const confirmMove = async (targetWorkspaceId: string) => {
    if (!channelId) return
    setIsMovingWorkspace(true)
    try {
      const result = await getTerosClient().channel.moveToWorkspace(channelId, targetWorkspaceId)
      const targetWs = workspaces.find((ws) => ws.workspaceId === targetWorkspaceId)
      toast.success(
        t("conversations.moveToWorkspaceSuccess", {
          workspace: targetWs?.name || targetWorkspaceId,
        }),
      )
      if (result.warnings && result.warnings.length > 0) {
        toast.warning(result.warnings.join(" "))
      }
      onMoved?.(targetWorkspaceId)
      onClose()
    } catch (err: any) {
      console.error("[MoveToWorkspaceModal] Error moving conversation:", err)
      toast.error(t("conversations.moveToWorkspaceError"), err?.message || undefined)
    } finally {
      setIsMovingWorkspace(false)
    }
  }

  const otherWorkspaces = workspaces.filter((ws) => ws.workspaceId !== activeWorkspaceId)

  return (
    <Dialog
      modal
      open={visible}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          key="overlay-move"
          animation="card"
          opacity={0.5}
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
        />
        <Dialog.Content
          key="content-move"
          animation="card"
          enterStyle={{ opacity: 0, scale: 0.96 }}
          exitStyle={{ opacity: 0, scale: 0.96 }}
          transformOrigin="top"
          width={440}
          maxWidth="92vw"
          maxHeight={520}
          padding={24}
          gap={16}
          borderRadius={16}
          borderWidth={0}
          backgroundColor={c.bgStep}
          // @ts-ignore — web-only lift
          style={{ boxShadow: c.elevRaised }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Tile sm icon="arrows-left-right" />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Dialog.Title asChild>
                <T step="xl">{t("conversations.moveToWorkspaceTitle")}</T>
              </Dialog.Title>
            </View>
          </View>
          <T step="sm" tone="text2">
            {t("conversations.moveToWorkspaceBody")}
          </T>

          {isMovingWorkspace || isLoadingWorkspaces ? (
            <View style={{ padding: 16, alignItems: "center", gap: 8 }}>
              <AppSpinner size="sm" variant="brand" />
            </View>
          ) : otherWorkspaces.length === 0 ? (
            <View style={{ padding: 16, alignItems: "center" }}>
              <T step="12" tone="text3">
                {t("conversations.moveToWorkspaceNoWorkspaces")}
              </T>
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 300 }}>
              <LGroup style={{ backgroundColor: c.nest }}>
                {otherWorkspaces.map((ws) => (
                  <LRow
                    key={ws.workspaceId}
                    hov
                    onPress={() => confirmMove(ws.workspaceId)}
                    testID={`move-ws-${ws.workspaceId}`}
                  >
                    <Ph name="buildings" size={16} color={c.accent} />
                    <T step="sm" ellipsis style={{ flex: 1 }}>
                      {ws.name}
                    </T>
                    <Ph name="caret-right" size={13} color={c.text3} />
                  </LRow>
                ))}
              </LGroup>
            </ScrollView>
          )}

          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Btn variant="ghost" onPress={onClose}>
              {t("conversations.moveToWorkspaceCancel")}
            </Btn>
          </View>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
