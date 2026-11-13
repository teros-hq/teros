import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { T } from "../../components/ui/ds"
import { firstName } from "./sessionText"
import { othersIn, sharedOfferNote, sharedOfferOpen } from "./terminalChrome"
import type { TerminalSession } from "./terminalSessions"
import type { SharedOffer, ToolbarState } from "./terminalWindowModel"
import { PopoverRow, PopoverSeparator, WindowPopover } from "./WindowPopover"

export function spaceCardWords(state: ToolbarState, t: TFunction): { title: string; text: string } {
  if (state.space === "shared")
    return {
      title: t("sharing.shared", { defaultValue: "Shared" }),
      text: t("terminal.window.spaceShared", {
        defaultValue:
          "The workspace's terminal: every member with write access sees it and types in it.",
      }),
    }
  if (state.watching)
    return {
      title: t("terminal.window.viewOnlyTitle", { defaultValue: "Personal · view only" }),
      text: t("terminal.window.spaceWatching", {
        defaultValue:
          "Someone's personal terminal. They let the workspace watch it: you see it live and cannot type in it.",
      }),
    }
  return {
    title: t("sharing.personal", { defaultValue: "Personal" }),
    text: state.watchable
      ? t("terminal.window.spaceWatched", {
          defaultValue:
            "Yours. The workspace can watch it live, with whatever it shows. Nobody else can type in it.",
        })
      : t("terminal.window.spacePersonal", {
          defaultValue: "Yours: only you see it and type in it.",
        }),
  }
}

interface Props {
  session: TerminalSession
  state: ToolbarState
  me: string | undefined
  top: number
  sharedOffer?: SharedOffer
  onLetWatch: () => void
  onNewShared: () => void
  onClose: () => void
}

export function TerminalSpaceCard({
  session,
  state,
  me,
  top,
  sharedOffer,
  onLetWatch,
  onNewShared,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const names = othersIn(session, me)
    .map((o) => firstName(o.name) || "?")
    .join(", ")
  const { title, text } = spaceCardWords(state, t)
  const pick = (action: () => void) => () => {
    onClose()
    action()
  }
  const offers = state.mine
  return (
    <WindowPopover
      side="right"
      top={top}
      onClose={onClose}
      testID="terminal-space-card"
      header={
        <View
          style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: offers ? 6 : 12, gap: 4 }}
        >
          <T step="sm" style={{ color: c.text }}>
            {title}
          </T>
          <T step="sm" tone="text2" testID="terminal-space-card-text">
            {text}
          </T>
          {names ? (
            <T step="sm" tone="text3" testID="terminal-space-card-here">
              {t("terminal.window.hereNow", { defaultValue: "Here now: {{names}}", names })}
            </T>
          ) : null}
        </View>
      }
    >
      {offers ? (
        <>
          <PopoverSeparator />
          {state.canLetWatch ? (
            <PopoverRow
              testID="terminal-space-card-watch"
              icon={state.watchable ? "eye-slash" : "eye"}
              label={
                state.watchable
                  ? t("terminal.window.stopWatch", { defaultValue: "Stop letting them watch" })
                  : t("terminal.window.letWatch", { defaultValue: "Let the workspace watch…" })
              }
              detail={
                state.watchable
                  ? undefined
                  : t("terminal.window.letWatchDetail", {
                      defaultValue: "They see this screen; they cannot type",
                    })
              }
              onPress={pick(onLetWatch)}
            />
          ) : null}
          <PopoverRow
            testID="terminal-space-card-shared"
            icon="users"
            label={t("terminal.window.newShared", { defaultValue: "New shared terminal" })}
            detail={
              sharedOfferNote(sharedOffer, t) ??
              t("terminal.window.newSharedDetail", {
                defaultValue: "To work in one together",
              })
            }
            disabled={!sharedOfferOpen(sharedOffer)}
            onPress={pick(onNewShared)}
          />
        </>
      ) : null}
    </WindowPopover>
  )
}
