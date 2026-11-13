import { useState } from "react"
import { useTranslation } from "react-i18next"
import { getTerosClient } from "../../../../services/terosClientSingleton"
import {
  agentDisplayName,
  firstName,
  mayToggleAgent,
  busyTypist,
  type TypingSession,
  type Opener,
} from "../../../../windows/TerminalWindow/sessionText"
import type {
  TerminalSession,
  TerminalWheelRequest,
} from "../../../../windows/TerminalWindow/terminalSessions"
import { T } from "../../../ui/ds"
import { CardButton, CardButtons, CardNote, CardShell, SessionOpenButtons } from "./cardKit"

export type ControlAnswerer = { by: "typist"; name: string } | { by: "opener" }

interface Props {
  terminalId: string
  sessionName: string
  request: TerminalWheelRequest | null
  canAnswer: boolean
  agentName?: string | null
  opener?: Opener | null
  answeredAs?: "approved" | "denied" | null
  answerer?: ControlAnswerer | null
  workspaceName?: string | null
  onFloat?: () => void
  onShow?: () => void
  testID?: string
}

export function controlAnswererOf(
  session: TypingSession & Pick<TerminalSession, "createdBy" | "space">,
  me: string | undefined,
  now: number = Date.now(),
): ControlAnswerer | null {
  const busy = busyTypist(session, me, now)
  if (busy) return { by: "typist", name: firstName(busy.name) || busy.id }
  return mayToggleAgent(session, me, now) ? null : { by: "opener" }
}

export function WheelRequestCard({
  terminalId,
  sessionName,
  request,
  canAnswer,
  agentName,
  opener,
  answeredAs,
  answerer,
  workspaceName,
  onFloat,
  onShow,
  testID,
}: Props) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [mine, setAnswered] = useState<boolean | null>(null)
  const answered = mine ?? (answeredAs ? answeredAs === "approved" : null)
  const [error, setError] = useState<string | null>(null)
  const agent = request?.agent.name || agentName || agentDisplayName(request?.agent ?? null)

  const answer = async (approve: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await getTerosClient()!.send("terminal", "answerWheel", {
        terminalId,
        approve,
        agentId: request?.agent.id,
      })
      setAnswered(approve)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const open = !!request && canAnswer && !answerer && answered === null
  const openActions =
    request && answered === null && onFloat && onShow ? { onFloat, onShow } : null
  const canOpen = openActions !== null
  const status =
    answered === true
      ? t("terminal.controlRequest.approved", { defaultValue: "{{agent}} can type now.", agent })
      : answered === false
        ? t("terminal.controlRequest.denied", { defaultValue: "You kept Agent off." })
        : !request
          ? t("terminal.controlRequest.answered", { defaultValue: "Answered." })
          : !canAnswer
            ? t("terminal.controlRequest.readOnly", {
                defaultValue: "Someone with write access to this workspace can answer it.",
              })
            : answerer?.by === "typist"
              ? t("terminal.controlRequest.typistAnswers", {
                  defaultValue: "{{name}} is typing there: only they can answer.",
                  name: answerer.name,
                })
              : answerer?.by === "opener"
                ? t("terminal.controlRequest.openerAnswers", {
                    defaultValue: "Only the person who opened this session can answer.",
                  })
                : null

  return (
    <CardShell testID={testID ?? "control-request"} active={open}>
      <T step="sm" style={{ marginBottom: 3 }}>
        {t("terminal.controlRequest.title", {
          defaultValue: "{{agent}} asks to use {{session}}",
          agent,
          session: sessionName,
        })}
        {opener ? (
          <T testID="control-request-opener" step="sm" tone="text3">
            {" · "}
            {opener === "you"
              ? t("terminal.controlRequest.openedByYou", { defaultValue: "opened by you" })
              : opener === "member"
                ? t("terminal.controlRequest.openedByMember", {
                    defaultValue: "opened by another member",
                  })
                : t("terminal.controlRequest.openedByAgent", {
                    defaultValue: "opened by an agent",
                  })}
          </T>
        ) : null}
      </T>
      {workspaceName ? (
        <T testID="control-request-meta" step="12" tone="text3" ellipsis style={{ marginBottom: 3 }}>
          {workspaceName}
        </T>
      ) : null}
      {request?.reason ? (
        <T step="sm" tone="text2">
          {request.reason}
        </T>
      ) : null}
      {open || canOpen ? (
        <CardButtons>
          {open ? (
            <>
              <CardButton
                testID="control-request-allow"
                primary
                disabled={busy}
                onPress={() => void answer(true)}
              >
                {t("terminal.controlRequest.allow", { defaultValue: "Allow" })}
              </CardButton>
              <CardButton
                testID="control-request-deny"
                disabled={busy}
                onPress={() => void answer(false)}
              >
                {t("terminal.controlRequest.deny", { defaultValue: "Keep off" })}
              </CardButton>
            </>
          ) : null}
          {openActions ? (
            <SessionOpenButtons
              testID="control-request"
              onFloat={openActions.onFloat}
              onShow={openActions.onShow}
            />
          ) : null}
        </CardButtons>
      ) : null}
      {error ? (
        <CardNote testID="control-request-error" error>
          {error}
        </CardNote>
      ) : status ? (
        <CardNote>{status}</CardNote>
      ) : null}
    </CardShell>
  )
}
