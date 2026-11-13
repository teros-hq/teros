import type { MemberRole } from "@teros/shared"
import { useTilingStore } from "../../store/tilingStore"
import { SessionsList } from "./SessionsList"
import { goToWindow, type TerminalSession } from "./terminalSessions"
import {
  nextWindowProps,
  pickerTarget,
  type SessionGroup,
  type SharedOffer,
} from "./terminalWindowModel"

interface Props {
  windowId: string
  workspaceId: string
  groups: SessionGroup[]
  me?: string
  role?: MemberRole
  sharedOffer?: SharedOffer
  touch?: boolean
  onEnd: (session: TerminalSession) => void
}

export function TerminalPicker({
  windowId,
  workspaceId,
  groups,
  me,
  role,
  sharedOffer,
  touch,
  onEnd,
}: Props) {
  const tiling = () => useTilingStore.getState()
  return (
    <SessionsList
      newFirst
      groups={groups}
      currentId={null}
      me={me}
      role={role}
      sharedOffer={sharedOffer}
      touch={touch}
      onPick={(terminalId) => {
        const target = pickerTarget(tiling().windows, windowId, terminalId)
        if ("focus" in target) {
          goToWindow(target.focus)
          tiling().closeWindow(windowId)
        } else tiling().updateWindowProps(windowId, { terminalId: target.attach })
      }}
      onNew={(space) => {
        const props = nextWindowProps({}, workspaceId, space)
        if (props) tiling().updateWindowProps(windowId, props)
      }}
      onEnd={onEnd}
      onClose={() => tiling().closeWindow(windowId)}
    />
  )
}
