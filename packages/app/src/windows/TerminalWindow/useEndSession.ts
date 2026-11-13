import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { useToast } from "../../components/Toast"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useTilingStore } from "../../store/tilingStore"
import { cancelClose, scheduleClose, UNDO_MS, undoClose } from "./closeTerminal"
import {
  sessionLabel,
  showTerminalSession,
  type TerminalSession,
  windowOfSession,
} from "./terminalSessions"

export function useEndSession(
  workspaceId: string | null | undefined,
): (target: TerminalSession) => void {
  const { t } = useTranslation()
  const toast = useToast()
  return useCallback(
    (target: TerminalSession) => {
      const client = getTerosClient()
      const id = target.terminalId
      const name = sessionLabel(target)
      const failed = (err: unknown) => {
        cancelClose(id)
        toast.error(
          t("terminal.killFailed", { defaultValue: "Could not end the session" }),
          err instanceof Error ? err.message : String(err),
        )
      }
      if (!client) {
        failed(t("terminal.reconnecting", { defaultValue: "Reconnecting…" }))
        return
      }
      const tiling = useTilingStore.getState()
      const shown = windowOfSession(tiling.windows, id)
      if (shown) tiling.closeWindow(shown.id)
      toast.show(t("terminal.window.ended", { defaultValue: "{{name}} ended", name }), {
        type: "info",
        duration: UNDO_MS,
        action: {
          label: t("terminal.window.undo", { defaultValue: "Undo" }),
          onPress: () => {
            void undoClose(
              id,
              async (terminal) =>
                (await client.send("terminal", "cancelClose", { terminalId: terminal })) as {
                  cancelled?: boolean
                },
            ).then((kept) => {
              if (kept) showTerminalSession(workspaceId, id)
              else
                toast.show(
                  t("terminal.window.undoTooLate", {
                    defaultValue: "Too late: {{name}} had already ended",
                    name,
                  }),
                  { type: "info" },
                )
            })
          },
        },
      })
      scheduleClose(id, () => {
        client.send("terminal", "destroy", { terminalId: id, undoMs: UNDO_MS }).catch(failed)
      })
    },
    [t, toast, workspaceId],
  )
}
