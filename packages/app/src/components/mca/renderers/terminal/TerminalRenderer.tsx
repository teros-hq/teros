import type React from "react"
import { useContext, useMemo, useRef } from "react"
import { useAuthStore } from "../../../../store/authStore"
import { useNavbarStore } from "../../../../store/navbarStore"
import { useWorkspaceStore } from "../../../../store/workspaceStore"
import { firstName, openerOf } from "../../../../windows/TerminalWindow/sessionText"
import {
  sessionLabel,
  useTerminalSessions,
} from "../../../../windows/TerminalWindow/terminalSessions"
import { openTerminalNeed } from "../../../needsYou/openTerminalNeed"
import { DefaultToolCallRenderer } from "../../DefaultToolCallRenderer"
import { ToolCallAuthorContext, type ToolCallRendererProps } from "../../types"
import { NeedsYouCard } from "./NeedsYouCard"
import {
  type ChatControlSeen,
  type ControlOutcome,
  chatControlCard,
  controlOutcomeOf,
  controlRequestOf,
  needsYouOf,
  parseTerminalQuestion,
} from "./needsYou"
import { controlAnswererOf, WheelRequestCard } from "./WheelRequestCard"

function AgentControlRequest({
  terminalId,
  outcome,
}: {
  terminalId: string
  outcome: ControlOutcome | null
}) {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const role = useNavbarStore((s) => s.workspaces.find((w) => w.workspaceId === workspaceId)?.role)
  const call = useContext(ToolCallAuthorContext)
  const author = call?.name
  const me = useAuthStore((s) => s.user?.userId)
  const { sessions } = useTerminalSessions(workspaceId)
  const session = sessions.find((s) => s.terminalId === terminalId)
  const seen = useRef<ChatControlSeen | null>(null)
  if (!session) return null
  const pending = session.wheelRequest ?? null
  const card = chatControlCard({
    request: pending,
    driver: session.driver ?? null,
    outcome,
    seen: seen.current,
    call,
  })
  seen.current = card.seen
  if (!card.show) return null
  const answeredAs = card.answeredAs
  const live =
    answeredAs === null && card.seen?.ended === null && card.seen.agentId === pending?.agent.id
  return (
    <WheelRequestCard
      terminalId={terminalId}
      sessionName={sessionLabel(session)}
      request={live ? pending : null}
      answeredAs={answeredAs}
      canAnswer={role !== "read"}
      answerer={controlAnswererOf(session, me)}
      agentName={author ? firstName(author) : null}
      opener={session.createdBy ? openerOf(session, me) : null}
      onFloat={() => void openTerminalNeed(workspaceId, terminalId, "float")}
      onShow={() => void openTerminalNeed(workspaceId, terminalId)}
    />
  )
}

export function TerminalToolCallRenderer(props: ToolCallRendererProps): React.ReactNode {
  const { status, output, input, toolName } = props
  const structuredContent = (props as { structuredContent?: unknown }).structuredContent
  const need = useMemo(
    () => needsYouOf({ status, output, input, structuredContent }),
    [status, output, input, structuredContent],
  )
  const question = useMemo(
    () => (need ? parseTerminalQuestion(need.screen, need.hint) : null),
    [need],
  )
  const controlFor = controlRequestOf({ toolName, status, input })
  return (
    <>
      <DefaultToolCallRenderer {...props} />
      {need && question ? <NeedsYouCard terminalId={need.terminalId} question={question} /> : null}
      {controlFor ? (
        <AgentControlRequest
          terminalId={controlFor}
          outcome={controlOutcomeOf({ structuredContent, output })}
        />
      ) : null}
    </>
  )
}

export default TerminalToolCallRenderer
