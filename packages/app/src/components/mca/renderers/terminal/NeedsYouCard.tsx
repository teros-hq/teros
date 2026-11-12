/**
 * The needs-you card: a coding agent in a terminal asks something (a
 * permission prompt, a menu) and the Teros agent hands the person the wheel.
 * Shows the terminal's face, what it wants, its numbered options as buttons
 * (a click types that key into the session as the person, through
 * terminal.write), "Open floating" and "Go to the terminal". Live: once the
 * session stops waiting the options go quiet.
 *
 * The same card in the chat (after a blocked terminal tool result) and in the
 * general notices (components/needsYou), where the session may live in
 * another workspace: `workspaceId` says which, and the notice adds the
 * workspace and who drives under the title.
 */

import { useContext, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, Text, View } from "react-native"
import Svg, { Path, Rect } from "react-native-svg"
import { getTerosClient } from "../../../../services/terosClientSingleton"
import { useWorkspaceStore } from "../../../../store/workspaceStore"
import { driverLabel, Face, Seat } from "../../../../windows/TerminalWindow/crew"
import { firstName } from "../../../../windows/TerminalWindow/crew/crewModel"
import {
  sessionLabel,
  useTerminalSessions,
} from "../../../../windows/TerminalWindow/terminalSessions"
import { type OpenHow, openTerminalNeed } from "../../../needsYou/openTerminalNeed"
import { useMcaTheme } from "../../primitives/useColors"
import { ToolCallAuthorContext } from "../../types"
import { shortOptionLabel, type TerminalQuestion } from "./needsYou"

const PALETTE = {
  light: {
    bg: "#FFF9EC",
    border: "#F3D9A4",
    text: "#3A2A08",
    title: "#7A4A00",
    code: "#FFFFFF",
    codeBorder: "#F0E2C4",
    btn: "#FFFFFF",
    btnBorder: "#EAD9B6",
    btnText: "#3A2A08",
    pri: "#1E1A26",
    priText: "#FFFFFF",
    muted: "#8A7550",
  },
  dark: {
    bg: "#241A08",
    border: "#4A3510",
    text: "#F3E6CC",
    title: "#FFD593",
    code: "#1A1306",
    codeBorder: "#4A3510",
    btn: "#1A1721",
    btnBorder: "#4A3510",
    btnText: "#F3EFF9",
    pri: "#F3EFF9",
    priText: "#1E1A26",
    muted: "#A08A60",
  },
} as const

const MONO = Platform.select({
  web: "'JetBrains Mono', ui-monospace, Menlo, monospace",
  default: "Menlo",
})

interface Props {
  terminalId: string
  question: TerminalQuestion
  /** The Teros agent that asked (the tool call's agent), if known. */
  agentName?: string | null
  /** The session's workspace (default: the active one, as in a chat). */
  workspaceId?: string | null
  /** A notice names the workspace (and who drives) under the title. */
  workspaceName?: string | null
  /** After "Open floating" / "Go to the terminal" (a notice sheet closes itself). */
  onOpen?: (how: OpenHow) => void
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
  const theme = useMcaTheme()
  const p = PALETTE[theme]
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const workspaceId = givenWorkspaceId ?? activeWorkspaceId
  const { sessions, loaded } = useTerminalSessions(workspaceId)
  const session = sessions.find((s) => s.terminalId === terminalId)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Still waiting? (unknown until the session list loads: assume yes)
  const waiting = !loaded || session?.agentState?.state === "blocked"
  const gone = loaded && !session
  const active = waiting && !gone && !sent
  const name = session
    ? sessionLabel(session)
    : t("terminal.float.untitled", { defaultValue: "Terminal" })
  // The agent's own name: the session's driver when the backend knows it, else the chat message's agent
  const author = useContext(ToolCallAuthorContext)?.name
  const driverAgent =
    session?.driver?.kind === "agent" && session.driver.name && session.driver.name !== "Agent"
      ? session.driver.name
      : undefined
  const agent = firstName(agentName ?? driverAgent ?? author)

  const answer = (key: string) => {
    setError(null)
    setSent(key)
    const client = getTerosClient()
    if (!client) return
    // The card's premise is "the agent hands you the wheel": take it before
    // typing, or the answer is refused (an agent at the wheel keeps the pane
    // read-only until the person takes over).
    client
      .send("terminal", "takeWheel", { terminalId })
      .catch(() => undefined) // already mine, or the server doesn't know the wheel
      .then(() =>
        client.send("terminal", "write", { terminalId, data: key, sendEnter: false }),
      )
      .catch((err: unknown) => {
        setSent(null)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  const open = (how: OpenHow) => {
    onOpen?.(how)
    void openTerminalNeed(workspaceId, terminalId, how)
  }

  const meta = workspaceName
    ? [workspaceName, session ? driverLabel(session) : null].filter(Boolean).join(" · ")
    : null

  const title = agent
    ? t("terminal.chat.needsYouHandsWheel", {
        defaultValue: "{{name}} needs you · {{agent}} hands you the wheel",
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

  function tf(key: string, fallback: string) {
    return t(key, { defaultValue: fallback })
  }

  return (
    <View
      testID="terminal-needs-you"
      style={{
        flexDirection: "row",
        gap: 10,
        alignItems: "flex-start",
        borderWidth: 1,
        borderColor: p.border,
        backgroundColor: p.bg,
        borderRadius: 14,
        paddingVertical: 11,
        paddingHorizontal: 13,
        marginTop: 6,
        opacity: active || sent ? 1 : 0.72,
      }}
    >
      <View style={{ position: "relative" }}>
        <Face
          session={session}
          terminalId={terminalId}
          state={active ? "need" : undefined}
          size={28}
        />
        {/* Who drives, on the face's corner (the rail's and the bubble's seat) */}
        {session ? (
          <Seat session={session} size={13} gap={p.bg} corner offset={5} animate={false} />
        ) : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontWeight: "600", fontSize: 12.5, color: p.title, marginBottom: 2 }}>
          {title}
        </Text>
        {meta ? (
          <Text
            testID="terminal-needs-you-meta"
            numberOfLines={1}
            style={{ fontSize: 11.5, color: p.muted, marginBottom: 3 }}
          >
            {meta}
          </Text>
        ) : null}
        {question.detail ? (
          <Text style={{ fontSize: 13, color: p.text, lineHeight: 19 }}>
            {t("terminal.chat.wantsToRun", { defaultValue: "Wants to run" })}{" "}
            <Text
              style={{
                fontFamily: MONO,
                fontSize: 12,
                backgroundColor: p.code,
                borderColor: p.codeBorder,
                borderWidth: 1,
                borderRadius: 4,
                paddingHorizontal: 4,
              }}
            >
              {question.detail}
            </Text>
            {question.question ? (
              <Text style={{ color: p.muted }}>{` · ${question.question}`}</Text>
            ) : null}
          </Text>
        ) : question.question ? (
          <Text style={{ fontSize: 13, color: p.text, lineHeight: 19 }}>{question.question}</Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {question.options.map((o, i) => (
            <CardButton
              key={o.key}
              testID={`terminal-needs-you-option-${o.key}`}
              primary={i === 0}
              disabled={!active}
              title={o.label}
              onPress={() => answer(o.key)}
              p={p}
            >
              {`${o.key} · ${shortOptionLabel(o.label, tf)}`}
            </CardButton>
          ))}
          {!gone ? (
            <CardButton
              testID="terminal-needs-you-float"
              p={p}
              onPress={() => open("float")}
              icon={<PipIcon color={p.btnText} />}
            >
              {t("terminal.chat.openFloating", { defaultValue: "Open floating" })}
            </CardButton>
          ) : null}
          {!gone ? (
            <CardButton testID="terminal-needs-you-goto" p={p} onPress={() => open("terminal")}>
              {t("terminal.chat.goToTerminal", { defaultValue: "Go to the terminal" })}
            </CardButton>
          ) : null}
        </View>
        {status || error ? (
          <Text style={{ fontSize: 11.5, color: error ? "#B4231B" : p.muted, marginTop: 6 }}>
            {error ?? status}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

function CardButton({
  children,
  onPress,
  primary,
  disabled,
  title,
  icon,
  testID,
  p,
}: {
  children: string
  onPress: () => void
  primary?: boolean
  disabled?: boolean
  title?: string
  icon?: React.ReactNode
  testID?: string
  p: (typeof PALETTE)[keyof typeof PALETTE]
}) {
  const pri = primary && !disabled
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title ?? children}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingVertical: 6,
        paddingHorizontal: 11,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: pri ? p.pri : p.btnBorder,
        backgroundColor: pri ? p.pri : p.btn,
        opacity: disabled ? 0.5 : (state as { hovered?: boolean }).hovered ? 0.88 : 1,
      })}
    >
      {icon}
      <Text style={{ fontSize: 12, fontWeight: "500", color: pri ? p.priText : p.btnText }}>
        {children}
      </Text>
    </Pressable>
  )
}

function PipIcon({ color }: { color: string }) {
  return (
    <Svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
    >
      <Path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4" />
      <Rect width={10} height={7} x={12} y={13} rx={2} />
    </Svg>
  )
}
