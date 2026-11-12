/**
 * A terminal that needs the person, as a notice: the chat's needs-you card
 * (NeedsYouCard — one component for both), with the question read from the
 * session's screen and its workspace named.
 */

import { NeedsYouCard } from "../mca/renderers/terminal/NeedsYouCard"
import type { OpenHow } from "./openTerminalNeed"
import { fallbackQuestion, useScreenQuestion } from "./screenQuestion"
import type { TerminalNeed } from "./terminalNeeds"

interface Props {
  need: TerminalNeed
  /** Called on "Open floating" / "Go to the terminal" (close the sheet it sits in). */
  onOpen?: (how: OpenHow) => void
}

export function TerminalNeedCard({ need, onOpen }: Props) {
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
