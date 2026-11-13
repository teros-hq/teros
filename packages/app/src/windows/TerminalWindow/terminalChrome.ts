import type { Space } from "@teros/shared"
import type { TFunction } from "i18next"
import type {
  WindowCloseQuestion,
  WindowFace,
  WindowMenuEntry,
  WindowTabIcon,
  WindowTabMark,
} from "../../store/windowChromeStore"
import { type CloseOutcome, closeOutcome } from "./closeTerminal"
import { sessionLabel, type TerminalSession } from "./terminalSessions"
import { agentDisplayName, busyTypist, firstName } from "./sessionText"
import type { SharedOffer, ToolbarState } from "./terminalWindowModel"

export interface TerminalMenuActions {
  goToSession: () => void
  rename: () => void
  openNew: (space: Space) => void
  openToSide: () => void
  end: () => void
  toggleOptionMeta?: () => void
}

export interface TerminalMenuOptions {
  me?: string
  mac: boolean
  sideSpace: Space
  sharedOffer?: SharedOffer
  optionIsMeta?: boolean
  statusLine?: string
  now?: number
}

export function shortcutLabel(key: string, mac: boolean): string {
  return mac ? `⌘⇧${key}` : `Ctrl+Shift+Alt+${key}`
}

export function othersIn(session: TerminalSession, me: string | undefined): WindowFace[] {
  const seen = new Set<string>()
  const faces: WindowFace[] = []
  for (const w of session.watchers ?? []) {
    const face: WindowFace =
      typeof w === "string"
        ? { id: w, name: "?" }
        : { id: w.id, name: w.name, imageUrl: w.avatarUrl, agent: w.kind === "agent" }
    if (!face.id || face.id === me || seen.has(face.id)) continue
    seen.add(face.id)
    faces.push(face)
  }
  return faces
}

export function terminalTabIcon(
  session: TerminalSession,
  state: ToolbarState,
  t: TFunction,
): WindowTabIcon | null {
  const d = session.driver
  if (d?.kind === "agent") {
    const name = agentDisplayName(d)
    return {
      face: { id: d.id ?? "agent", name, imageUrl: d.avatarUrl, agent: true },
      pulse: true,
      tooltip: t("terminal.window.someoneTypes", { defaultValue: "{{name}} is typing", name }),
    }
  }
  if (!state.consent) return null
  return {
    icon: "robot",
    tone: "accent",
    tooltip: t("terminal.window.agentOnHint", {
      defaultValue: "Agent on: agents can see and type here",
    }),
  }
}

export function terminalTabMarks(
  session: TerminalSession,
  state: ToolbarState,
  me: string | undefined,
  t: TFunction,
): WindowTabMark[] {
  const others = othersIn(session, me)
  if (state.space === "shared")
    return [
      {
        id: "shared",
        icon: "users",
        faces: others,
        label:
          others.length > 0
            ? t("terminal.window.sharedWith", {
                defaultValue: "Shared · here now: {{names}}",
                names: others.map((o) => firstName(o.name) || "?").join(", "),
              })
            : t("sharing.shared", { defaultValue: "Shared" }),
      },
    ]
  if (state.watching)
    return [
      {
        id: "view-only",
        icon: "eye",
        label: t("terminal.window.watchingHint", {
          defaultValue: "Someone's personal terminal: you can watch it, not type in it",
        }),
      },
    ]
  if (state.watchable)
    return [
      {
        id: "watched",
        icon: "eye",
        count: others.length,
        label: t("terminal.window.watchedMark", {
          defaultValue: "Yours, and the workspace can watch it",
        }),
      },
    ]
  return []
}

export function agentReason(
  session: TerminalSession,
  state: ToolbarState,
  t: TFunction,
  options: Pick<TerminalMenuOptions, "me" | "now">,
): string | undefined {
  if (state.canToggle) return undefined
  if (state.watching)
    return t("terminal.window.agentNotYours", {
      defaultValue: "Only its person switches Agent here",
    })
  const busy = busyTypist(session, options.me, options.now)
  if (!busy) return undefined
  return t("terminal.window.agentBusy", {
    defaultValue: "{{name}} typed here in the last minute",
    name: firstName(busy.name) || "?",
  })
}

export function sharedOfferNote(offer: SharedOffer | undefined, t: TFunction): string | undefined {
  if (!offer || offer.kind === "ready") return undefined
  return offer.mine
    ? t("terminal.window.needsBashNote", {
        defaultValue: "Needs the Bash app to be shared · My Apps → Bash → Settings",
      })
    : t("terminal.window.needsBashNoteOther", {
        defaultValue: "Needs the Bash app to be shared · ask the member who installed it",
      })
}

export function sharedOfferOpen(offer: SharedOffer | undefined): boolean {
  return !offer || offer.kind === "ready"
}

export function newTerminalEntries(
  t: TFunction,
  actions: Pick<TerminalMenuActions, "goToSession" | "openNew">,
  mac: boolean,
  offer?: SharedOffer,
): WindowMenuEntry[] {
  return [
    {
      id: "go-session",
      icon: "magnifying-glass",
      label: t("terminal.window.goToSession", { defaultValue: "Go to session…" }),
      shortcut: shortcutLabel("O", mac),
      onPress: actions.goToSession,
    },
    {
      id: "new-personal",
      icon: "lock-simple",
      label: t("terminal.window.newPersonal", { defaultValue: "New personal terminal" }),
      onPress: () => actions.openNew("personal"),
    },
    {
      id: "new-shared",
      icon: "users",
      label: t("terminal.window.newShared", { defaultValue: "New shared terminal" }),
      detail: sharedOfferNote(offer, t),
      disabled: sharedOfferOpen(offer) ? undefined : true,
      onPress: () => actions.openNew("shared"),
    },
  ]
}

export function terminalMenu(
  session: TerminalSession,
  state: ToolbarState,
  t: TFunction,
  actions: TerminalMenuActions,
  options: TerminalMenuOptions,
): WindowMenuEntry[] {
  const [goTo, newPersonal, newShared] = newTerminalEntries(
    t,
    actions,
    options.mac,
    options.sharedOffer,
  )
  const entries: Array<WindowMenuEntry | null> = [
    goTo,
    state.canManage
      ? {
          id: "rename",
          icon: "pencil-simple-line",
          label: t("terminal.window.rename", { defaultValue: "Rename" }),
          onPress: actions.rename,
        }
      : null,
    newPersonal,
    newShared,
    {
      id: "new-side",
      icon: "columns",
      label: t("terminal.window.openToSide", { defaultValue: "New terminal to the side" }),
      trailing:
        options.sideSpace === "shared"
          ? t("sharing.shared", { defaultValue: "Shared" })
          : t("sharing.personal", { defaultValue: "Personal" }),
      onPress: actions.openToSide,
    },
    actions.toggleOptionMeta
      ? {
          id: "option-meta",
          icon: "option",
          label: t("terminal.optionMeta", { defaultValue: "Option key as Meta (Alt)" }),
          checked: options.optionIsMeta === true,
          trailing: options.optionIsMeta
            ? t("terminal.window.on", { defaultValue: "On" })
            : undefined,
          onPress: actions.toggleOptionMeta,
        }
      : null,
    state.canManage
      ? {
          id: "end",
          icon: "x",
          danger: true,
          separated: true,
          label: t("terminal.window.endSession", { defaultValue: "End session" }),
          trailing: options.statusLine || undefined,
          onPress: actions.end,
        }
      : null,
  ]
  return entries.filter((entry): entry is WindowMenuEntry => entry !== null)
}

export function closeNote(outcome: CloseOutcome, name: string, t: TFunction): string | null {
  if (outcome !== "keep") return null
  return t("terminal.window.keepsRunningShared", {
    defaultValue: "{{name}} keeps running for the workspace",
    name,
  })
}

export interface TerminalCloseContext {
  me: string | undefined
  shownElsewhere: boolean
  end: () => void
  note: (text: string) => void
}

export function terminalCloseGuard(
  session: TerminalSession,
  t: TFunction,
  context: Pick<TerminalCloseContext, "me" | "shownElsewhere" | "end">,
): WindowCloseQuestion | null {
  if (context.shownElsewhere || closeOutcome(session, context.me) !== "ask") return null
  return {
    message: t("terminal.window.closeBusy", {
      defaultValue: "{{name}} has something running. Ending it stops it.",
      name: sessionLabel(session),
    }),
    confirmLabel: t("terminal.window.closeEnd", { defaultValue: "End" }),
    keepLabel: t("terminal.window.closeKeep", { defaultValue: "Keep running" }),
    onConfirm: context.end,
  }
}

export function terminalClosed(
  session: TerminalSession,
  t: TFunction,
  context: TerminalCloseContext,
): void {
  if (context.shownElsewhere) return
  const outcome = closeOutcome(session, context.me)
  if (outcome === "end") {
    context.end()
    return
  }
  const note = closeNote(outcome, sessionLabel(session), t)
  if (note) context.note(note)
}

export function watchConfirmText(sharedOpen: boolean, t: TFunction): string {
  return sharedOpen
    ? t("terminal.window.watchConfirm", {
        defaultValue:
          "Let the workspace watch this terminal? Every member with write access will see this screen live, with whatever it shows. They cannot type in it or reach your home. To work together, open a shared terminal instead.",
      })
    : t("terminal.window.watchConfirmNoShared", {
        defaultValue:
          "Let the workspace watch this terminal? Every member with write access will see this screen live, with whatever it shows. They cannot type in it or reach your home.",
      })
}
