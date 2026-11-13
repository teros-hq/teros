import type { MemberRole, Space } from "@teros/shared"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { TextInput, View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { Ph, T } from "../../components/ui/ds"
import { WindowStatusMark } from "../../components/workspace/TabStatusSlot"
import { TabMarks } from "../../components/workspace/WindowChrome"
import { useBrowserInputStyles } from "../BrowserWindow/BrowserToolbar"
import { isBusy, isClosing, useClosingVersion } from "./closeTerminal"
import { StartPage } from "./TerminalStartPage"
import { sessionStatus, useSessionMarks } from "./sessionStatus"
import { typistLabel, typistOf } from "./sessionText"
import { sharedOfferNote, sharedOfferOpen, terminalTabMarks } from "./terminalChrome"
import { sessionLabel, type TerminalSession } from "./terminalSessions"
import {
  type SessionGroup,
  type SessionGroupKey,
  type SessionRow,
  type SharedOffer,
  toolbarOf,
} from "./terminalWindowModel"
import {
  PopoverLabel,
  PopoverRow,
  PopoverSeparator,
  type RowEnd,
  WindowPopover,
} from "./WindowPopover"

interface Props {
  groups: SessionGroup[]
  currentId: string | null
  me?: string
  role?: MemberRole
  sharedOffer?: SharedOffer
  onPick: (terminalId: string) => void
  onEnd?: (session: TerminalSession) => void
  mayEnd?: (session: TerminalSession) => boolean
  touch?: boolean
  newFirst?: boolean
  onNew: (space: Space) => void
  onClose: () => void
}

const GROUP_LABEL: Record<SessionGroupKey, { key: string; text: string }> = {
  mine: { key: "terminal.window.groupMine", text: "Personal · only you" },
  shared: { key: "terminal.window.groupShared", text: "Shared · the workspace's" },
  agents: { key: "terminal.window.groupAgents", text: "Shared · opened by agents" },
  watching: { key: "terminal.window.groupWatching", text: "Others' personal · view only" },
}

const SETTLE_MS = 350

function iconOf(session: TerminalSession): string {
  if (session.openedBy === "agent" || session.createdBy.startsWith("agent:")) return "robot"
  return session.kind === "claude" ? "sparkle" : "terminal"
}

type Choice =
  | { kind: "session"; id: string; row: SessionRow }
  | {
      kind: "new"
      id: string
      space: Space
      label: string
      detail: string
      icon: string
      disabled?: boolean
    }

export function SessionsList({
  groups,
  currentId,
  me,
  role,
  touch,
  newFirst,
  onPick,
  onNew,
  onEnd,
  mayEnd,
  sharedOffer,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const { newTabInputStyle } = useBrowserInputStyles()
  const [query, setQuery] = useState("")
  const [at, setAt] = useState(0)
  const [armed, setArmed] = useState<string | null>(null)
  const closing = useClosingVersion()
  const finished = useSessionMarks((s) => s.finished)
  const input = useRef<TextInput | null>(null)
  const born = useRef(Date.now())
  const focus = () => (input.current as unknown as HTMLInputElement | null)?.focus?.()
  useEffect(() => {
    focus()
    const again = setTimeout(focus, 80)
    return () => clearTimeout(again)
  }, [])
  useEffect(() => {
    if (typeof document === "undefined") return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const needle = query.trim().toLowerCase()
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle)
  const shown = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          rows: group.rows.filter(
            (row) => !isClosing(row.session.terminalId) && matches(sessionLabel(row.session)),
          ),
        }))
        .filter((group) => group.rows.length > 0),
    [groups, needle, closing],
  )
  const endOf = (session: TerminalSession): RowEnd | undefined => {
    const allowed = mayEnd ? mayEnd(session) : toolbarOf(session, me, role ?? "write").canManage
    if (!onEnd || !allowed) return undefined
    const name = sessionLabel(session)
    const isArmed = armed === session.terminalId
    return {
      label: isArmed
        ? t("terminal.confirmKill", { defaultValue: "Click again to end the session" })
        : t("terminal.window.endNamed", { defaultValue: "End {{name}}", name }),
      armedLabel: t("terminal.window.closeEnd", { defaultValue: "End" }),
      armed: isArmed,
      always: touch,
      onPress: () => {
        if (isBusy(session) && !isArmed) {
          setArmed(session.terminalId)
          return
        }
        setArmed(null)
        onEnd(session)
      },
    }
  }
  const fresh: Choice[] = [
    {
      kind: "new" as const,
      id: "terminal-sessions-new",
      space: "personal" as const,
      icon: "lock-simple",
      label: t("terminal.window.newPersonal", { defaultValue: "New personal terminal" }),
      detail: t("terminal.window.newPersonalDetail", { defaultValue: "Only you" }),
    },
    {
      kind: "new" as const,
      id: "terminal-sessions-new-shared",
      space: "shared" as const,
      icon: "users",
      label: t("terminal.window.newShared", { defaultValue: "New shared terminal" }),
      detail:
        sharedOfferNote(sharedOffer, t) ??
        t("terminal.window.newSharedDetail", { defaultValue: "The workspace's machine" }),
      disabled: !sharedOfferOpen(sharedOffer),
    },
  ].filter((choice) => matches(choice.label))
  const listed: Choice[] = shown.flatMap((group) =>
    group.rows.map((row) => ({ kind: "session" as const, id: row.session.terminalId, row })),
  )
  const choices: Choice[] = newFirst ? [...fresh, ...listed] : [...listed, ...fresh]
  const active = Math.min(at, Math.max(0, choices.length - 1))
  const choose = (choice: Choice | undefined) => {
    if (!choice) return
    if (choice.kind === "session") onPick(choice.id)
    else if (!choice.disabled) onNew(choice.space)
  }
  const detailOf = (session: TerminalSession, open: boolean, desktop?: string): string =>
    [
      session.lifecycle === "sleeping" || session.lifecycle === "frozen"
        ? t("terminal.window.asleep", { defaultValue: "Asleep" })
        : typistLabel(typistOf(session, me)),
      session.watchable && session.createdBy === me
        ? t("terminal.window.othersWatch", { defaultValue: "others can watch" })
        : "",
      desktop
        ? t("terminal.window.onDesktop", { defaultValue: "on {{desktop}}", desktop })
        : open
          ? t("terminal.window.hasWindow", { defaultValue: "In a window" })
          : "",
    ]
      .filter(Boolean)
      .join(" · ")

  const field = (
    <TextInput
      ref={input}
      testID="terminal-sessions-search"
      accessibilityLabel={t("terminal.window.goToSession", { defaultValue: "Go to session…" })}
      placeholder={t("terminal.window.goToSession", { defaultValue: "Go to session…" })}
      placeholderTextColor={c.text3}
      value={query}
      onChangeText={(text) => {
        setQuery(text)
        setAt(0)
      }}
      onSubmitEditing={() => choose(choices[active])}
      onBlur={() => {
        if (Date.now() - born.current < SETTLE_MS) setTimeout(focus, 0)
      }}
      onKeyPress={(e) => {
        const key = e.nativeEvent.key
        if (key === "Escape") onClose()
        if (key === "ArrowDown" || key === "ArrowUp") {
          e.preventDefault?.()
          const step = key === "ArrowDown" ? 1 : -1
          setAt((active + step + choices.length) % Math.max(1, choices.length))
        }
      }}
      autoCapitalize="none"
      autoCorrect={false}
      style={[
        newFirst
          ? { ...newTabInputStyle, flex: undefined, flexShrink: 0, fontFamily: "Saans" }
          : { flex: 1, minWidth: 0, height: 40, color: c.text, fontFamily: "Saans", fontSize: 14 },
        { outlineStyle: "none" } as object,
      ]}
    />
  )
  const header = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 14,
        height: 44,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      }}
    >
      <Ph name="magnifying-glass" size={15} color={c.text3} />
      {field}
      <T step="codenote" tone="text3">
        esc
      </T>
    </View>
  )

  const sessionRows = (
    <>
      {shown.map((group) => (
        <View key={group.key}>
          <PopoverLabel>
            {t(GROUP_LABEL[group.key].key, { defaultValue: GROUP_LABEL[group.key].text })}
          </PopoverLabel>
          {group.rows.map(({ session, open, desktop }) => (
            <PopoverRow
              key={session.terminalId}
              testID={`terminal-sessions-row-${session.terminalId}`}
              icon={iconOf(session)}
              label={sessionLabel(session)}
              detail={detailOf(session, open, desktop)}
              current={session.terminalId === currentId}
              focused={choices[active]?.id === session.terminalId}
              mark={
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <TabMarks
                    marks={terminalTabMarks(session, toolbarOf(session, me, role ?? "write"), me, t)}
                    color={c.text3}
                  />
                  <WindowStatusMark
                    status={sessionStatus(session, me, role ?? "write", finished)}
                  />
                </View>
              }
              end={endOf(session)}
              onPress={() => onPick(session.terminalId)}
            />
          ))}
        </View>
      ))}
    </>
  )
  const newRows = (
    <>
      {fresh.map((choice) =>
        choice.kind === "new" ? (
          <PopoverRow
            key={choice.id}
            testID={choice.id}
            icon={choice.icon}
            label={choice.label}
            detail={choice.detail}
            disabled={choice.disabled}
            focused={choices[active]?.id === choice.id}
            onPress={() => onNew(choice.space)}
          />
        ) : null,
      )}
    </>
  )
  const noMatch =
    choices.length === 0 ? (
      <T step="sm" tone="text3" style={{ padding: 14 }}>
        {t("terminal.window.noSessionMatches", { defaultValue: "No session matches" })}
      </T>
    ) : null
  if (newFirst)
    return (
      <StartPage field={field}>
        {newRows}
        {shown.length > 0 && fresh.length > 0 ? <PopoverSeparator /> : null}
        {sessionRows}
        {noMatch}
      </StartPage>
    )
  return (
    <WindowPopover side="center" onClose={onClose} testID="terminal-sessions" header={header}>
      {sessionRows}
      {shown.length > 0 && fresh.length > 0 ? <PopoverSeparator /> : null}
      {newRows}
      {noMatch}
    </WindowPopover>
  )
}
