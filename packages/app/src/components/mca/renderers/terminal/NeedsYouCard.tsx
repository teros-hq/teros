import { useContext, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { getTerosClient } from "../../../../services/terosClientSingleton"
import { useAuthStore } from "../../../../store/authStore"
import { useWorkspaceStore } from "../../../../store/workspaceStore"
import {
  firstName,
  isUnnamedAgent,
  typistLabel,
  typistOf,
} from "../../../../windows/TerminalWindow/sessionText"
import {
  sessionLabel,
  useTerminalSessions,
} from "../../../../windows/TerminalWindow/terminalSessions"
import { openTerminalNeed } from "../../../needsYou/openTerminalNeed"
import { Ph, T } from "../../../ui/ds"
import { ToolCallAuthorContext } from "../../types"
import {
  CardButton,
  CardButtons,
  CardNote,
  CardShell,
  SessionOpenButtons,
  useCardPalette,
} from "./cardKit"
import { shortOptionLabel, type TerminalQuestion } from "./needsYou"

interface Props {
  terminalId: string
  question: TerminalQuestion
  agentName?: string | null
  workspaceId?: string | null
  workspaceName?: string | null
  onOpen?: () => void
}

export function NeedsYouCard({
  terminalId,
  question,
  agentName,
  workspaceId: givenWorkspaceId,
  workspaceName,
  onOpen,
}: Props) {
  const { t } = useTranslation()
  const p = useCardPalette()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const me = useAuthStore((s) => s.user?.userId)
  const workspaceId = givenWorkspaceId ?? activeWorkspaceId
  const { sessions, loaded } = useTerminalSessions(workspaceId)
  const session = sessions.find((s) => s.terminalId === terminalId)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const waiting = !loaded || session?.agentState?.state === "blocked"
  const gone = loaded && !session
  const active = waiting && !gone && !sent
  const name = session
    ? sessionLabel(session)
    : t("terminal.chat.untitled", { defaultValue: "Terminal" })
  const author = useContext(ToolCallAuthorContext)?.name
  const driver = session?.driver
  const driverAgent = driver?.kind === "agent" && !isUnnamedAgent(driver) ? driver.name : undefined
  const agent = firstName(agentName ?? driverAgent ?? author)

  const tf = (key: string, fallback: string) => t(key, { defaultValue: fallback })

  const answer = (key: string) => {
    setError(null)
    setSent(key)
    const client = getTerosClient()
    if (!client) return
    client
      .send("terminal", "takeWheel", { terminalId })
      .catch(() => undefined)
      .then(() => client.send("terminal", "write", { terminalId, data: key, sendEnter: false }))
      .catch((err: unknown) => {
        setSent(null)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  const show = () => {
    onOpen?.()
    void openTerminalNeed(workspaceId, terminalId)
  }
  const float = () => {
    onOpen?.()
    void openTerminalNeed(workspaceId, terminalId, "float")
  }

  const meta = workspaceName
    ? [workspaceName, session ? typistLabel(typistOf(session, me)) : null]
        .filter(Boolean)
        .join(" · ")
    : null

  const title = agent
    ? t("terminal.chat.needsYouAgentWaits", {
        defaultValue: "{{name}} needs you · {{agent}} is waiting",
        name,
        agent,
      })
    : t("terminal.chat.needsYou", { defaultValue: "{{name}} needs you", name })

  const status = sent
    ? t("terminal.chat.sent", {
        defaultValue: "You answered {{key}}",
        key: `${sent} · ${shortOptionLabel(question.options.find((o) => o.key === sent)?.label ?? "", tf)}`,
      })
    : gone
      ? t("terminal.chat.ended", { defaultValue: "The session has ended" })
      : !waiting
        ? t("terminal.chat.answered", { defaultValue: "Answered" })
        : null

  return (
    <CardShell testID="terminal-needs-you" row active={active || !!sent}>
      <View
        testID="terminal-needs-you-icon"
        style={{
          width: 28,
          height: 28,
          borderRadius: 100,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: p.code,
          borderWidth: 1,
          borderColor: p.codeBorder,
        }}
      >
        <Ph name="terminal-window" size={15} color={active ? p.accent : p.muted} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T step="sm" style={{ marginBottom: 2 }}>
          {title}
        </T>
        {meta ? (
          <T
            testID="terminal-needs-you-meta"
            step="12"
            tone="text3"
            ellipsis
            style={{ marginBottom: 3 }}
          >
            {meta}
          </T>
        ) : null}
        {question.detail ? (
          <T step="sm" tone="text2">
            {t("terminal.chat.wantsToRun", { defaultValue: "Wants to run" })}{" "}
            <T
              step="code"
              style={{
                backgroundColor: p.code,
                borderColor: p.codeBorder,
                borderWidth: 1,
                borderRadius: 4,
                paddingHorizontal: 4,
              }}
            >
              {question.detail}
            </T>
            {question.question ? (
              <T step="sm" tone="text3">{` · ${question.question}`}</T>
            ) : null}
          </T>
        ) : question.question ? (
          <T step="sm" tone="text2">
            {question.question}
          </T>
        ) : null}
        <CardButtons>
          {question.options.map((o, i) => (
            <CardButton
              key={o.key}
              testID={`terminal-needs-you-option-${o.key}`}
              primary={i === 0}
              disabled={!active}
              title={o.label}
              onPress={() => answer(o.key)}
            >
              {`${o.key} · ${shortOptionLabel(o.label, tf)}`}
            </CardButton>
          ))}
          {!gone ? (
            <SessionOpenButtons testID="terminal-needs-you" onFloat={float} onShow={show} />
          ) : null}
        </CardButtons>
        {error ? (
          <CardNote testID="terminal-needs-you-error" error>
            {error}
          </CardNote>
        ) : status ? (
          <CardNote>{status}</CardNote>
        ) : null}
      </View>
    </CardShell>
  )
}
