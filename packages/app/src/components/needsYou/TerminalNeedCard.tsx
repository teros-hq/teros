import { useAuthStore } from "../../store/authStore"
import { useNavbarStore } from "../../store/navbarStore"
import { openerOf } from "../../windows/TerminalWindow/sessionText"
import { sessionLabel } from "../../windows/TerminalWindow/terminalSessions"
import { NeedsYouCard } from "../mca/renderers/terminal/NeedsYouCard"
import { controlAnswererOf, WheelRequestCard } from "../mca/renderers/terminal/WheelRequestCard"
import { openTerminalNeed } from "./openTerminalNeed"
import { fallbackQuestion, useScreenQuestion } from "./screenQuestion"
import type { TerminalNeed } from "./terminalNeeds"

interface Props {
  need: TerminalNeed
  onOpen?: () => void
}

function BlockedNeedCard({ need, onOpen }: Props) {
  const question = useScreenQuestion(need.session) ?? fallbackQuestion(need.session)
  return (
    <NeedsYouCard
      terminalId={need.session.terminalId}
      workspaceId={need.workspaceId}
      workspaceName={need.workspaceName}
      question={question}
      onOpen={onOpen}
    />
  )
}

function RequestNeedCard({ need, onOpen }: Props) {
  const me = useAuthStore((s) => s.user?.userId)
  const role = useNavbarStore(
    (s) => s.workspaces.find((w) => w.workspaceId === need.workspaceId)?.role,
  )
  const { session, workspaceId } = need
  const open = (mode: "tab" | "float") => {
    onOpen?.()
    void openTerminalNeed(workspaceId, session.terminalId, mode)
  }
  return (
    <WheelRequestCard
      terminalId={session.terminalId}
      sessionName={sessionLabel(session)}
      request={session.wheelRequest ?? null}
      canAnswer={role !== "read"}
      answerer={controlAnswererOf(session, me)}
      opener={session.createdBy ? openerOf(session, me) : null}
      workspaceName={need.workspaceName}
      onFloat={() => open("float")}
      onShow={() => open("tab")}
    />
  )
}

export function TerminalNeedCard({ need, onOpen }: Props) {
  return need.kind === "request" ? (
    <RequestNeedCard need={need} onOpen={onOpen} />
  ) : (
    <BlockedNeedCard need={need} onOpen={onOpen} />
  )
}
