import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, View, type ViewStyle } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { SpaceChip, tooltip } from "../../components/sharing/SpaceChip"
import { ConsentToggle } from "../BrowserWindow/BrowserToolbar"
import type { ToolbarState } from "./terminalWindowModel"

export const PILL_INSET = { top: 12, right: 18 }
export const PILL_REST = { surface: 0.62, control: 0.55, badge: 0.82 }
export const PILL_HEIGHT = 38
const WEB = Platform.OS === "web"

const fade = (opacity: number): ViewStyle =>
  ({
    opacity,
    ...(WEB ? { transitionProperty: "opacity", transitionDuration: "120ms" } : null),
  }) as ViewStyle

function useAwake() {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const handlers = WEB
    ? {
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        onFocus: () => setFocused(true),
        onBlur: (e: { currentTarget?: unknown; relatedTarget?: unknown }) => {
          const root = e.currentTarget as Node | undefined
          const next = e.relatedTarget as Node | null | undefined
          if (!root || !next || !root.contains?.(next)) setFocused(false)
        },
      }
    : {}
  return { awake: hovered || focused, handlers: handlers as object }
}

interface Props {
  state: ToolbarState
  narrow?: boolean
  active?: boolean
  reason?: string
  offShortcut?: string
  onToggleAgent: (enabled: boolean) => void
  onReason?: (reason: string) => void
  onSpace: () => void
}

function spaceWords(state: ToolbarState, t: (key: string, o: { defaultValue: string }) => string) {
  const detail = state.watching
    ? t("terminal.window.viewOnlyShort", { defaultValue: "view only" })
    : state.watchable
      ? t("terminal.window.othersWatch", { defaultValue: "others can watch" })
      : state.agentOpened
        ? t("terminal.window.agentSession", { defaultValue: "agent session" })
        : undefined
  const hint = state.watching
    ? t("terminal.window.watchingHint", {
        defaultValue: "Someone's personal terminal: you can watch it, not type in it",
      })
    : state.watchable
      ? t("terminal.window.watchedMark", { defaultValue: "Yours, and the workspace can watch it" })
      : undefined
  return { detail, hint }
}

export function TerminalCornerPill({
  state,
  narrow = false,
  active = false,
  reason,
  offShortcut,
  onToggleAgent,
  onReason,
  onSpace,
}: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const { awake, handlers } = useAwake()
  const quiet = !awake && !active
  const marked = state.watching || state.watchable
  const plainPersonal = state.space === "personal" && !marked
  const { detail, hint } = spaceWords(state, t as never)
  const dimSurface = quiet && !state.consent
  const blocked = state.canToggle ? undefined : reason
  const agentHint = state.canToggle
    ? state.consent
      ? [
          t("terminal.window.agentOnHint", {
            defaultValue: "Agent on: agents can see and type here",
          }),
          offShortcut,
        ]
          .filter(Boolean)
          .join(" · ")
      : t("terminal.window.agentOffHint", {
          defaultValue: "Agent off: agents cannot see or type here. Press to switch it on",
        })
    : reason
  return (
    <View
      testID="terminal-pill"
      {...handlers}
      {...({ dataSet: { quiet: quiet ? "true" : "false" } } as object)}
      style={{
        position: "absolute",
        top: PILL_INSET.top,
        right: PILL_INSET.right,
        zIndex: 20,
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        padding: 3,
        borderRadius: 11,
        borderWidth: 1,
        borderColor: dimSurface ? c.border : c.borderStrong,
      }}
    >
      <View
        testID="terminal-pill-surface"
        style={[
          {
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            borderRadius: 10,
            backgroundColor: c.bgStep,
            pointerEvents: "none",
          },
          fade(dimSurface ? PILL_REST.surface : 0.97),
          WEB
            ? ({ backdropFilter: "blur(10px) saturate(1.3)", boxShadow: c.elevHover } as ViewStyle)
            : null,
        ]}
      />
      <View style={fade(quiet && plainPersonal ? PILL_REST.badge : 1)}>
        <SpaceChip
          testID="terminal-space"
          space={state.space}
          detail={detail}
          icon={marked ? "eye" : state.agentOpened ? "robot" : undefined}
          short={narrow}
          hint={hint}
          onPress={onSpace}
        />
      </View>
      <View
        testID="terminal-agent"
        ref={tooltip(agentHint)}
        style={fade(quiet && !state.consent ? PILL_REST.control : 1)}
        {...(blocked ? ({ onClick: () => onReason?.(blocked) } as object) : null)}
      >
        <ConsentToggle
          testID="terminal-agent-toggle"
          consent={state.consent}
          disabled={!state.canToggle}
          onToggle={() => onToggleAgent(!state.consent)}
        />
      </View>
    </View>
  )
}
