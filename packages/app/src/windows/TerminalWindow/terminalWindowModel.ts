import {
  type AccessAction,
  actionsFor,
  type MemberRole,
  type Space,
  TERMINAL_SESSION_POLICY,
  terminalSessionSpace,
  terminalSessionThing,
} from "@teros/shared"
import { agentControlOf, someoneElseTyping, type Typist, typistOf } from "./sessionText"
import { newTerminalId, type TerminalSession } from "./terminalSessions"

export interface TerminalWindowState {
  workspaceId?: string
  terminalId?: string
  pendingCreate?: boolean
  space?: Space
}

export function nextWindowProps(
  props: TerminalWindowState,
  workspaceId: string,
  space: Space = "personal",
): { workspaceId: string; terminalId: string; pendingCreate: true; space: Space } | null {
  if (props.terminalId || !workspaceId) return null
  return { workspaceId, terminalId: newTerminalId(), pendingCreate: true, space }
}

export function opensOnPicker(props: {
  terminalId?: string
  preset?: string
  initialCwd?: string
  space?: string
  [other: string]: unknown
}): boolean {
  return !props.terminalId && !props.preset && !props.initialCwd && !props.space
}

export function pickerTarget(
  windows: Record<string, { id: string; type: string; props?: Record<string, any> }>,
  windowId: string,
  terminalId: string,
): { focus: string } | { attach: string } {
  const other = Object.values(windows).find(
    (w) => w.id !== windowId && w.type === "terminal" && w.props?.terminalId === terminalId,
  )
  return other ? { focus: other.id } : { attach: terminalId }
}

export function needsSpaceChoice(props: TerminalWindowState, others: number | null): boolean {
  return !props.terminalId && !props.space && (others ?? 0) > 0
}

export function sessionActions(
  session: TerminalSession,
  me: string | undefined,
  role: MemberRole = "write",
): AccessAction[] {
  if (!me) return []
  const workspaceId = session.ownerWorkspaceId ?? ""
  return actionsFor(
    { kind: "member", userId: me, workspaceId, role },
    terminalSessionThing(session, workspaceId),
    TERMINAL_SESSION_POLICY,
  )
}

export type SessionGroupKey = "mine" | "shared" | "agents" | "watching"

export interface SessionRow {
  session: TerminalSession
  open: boolean
  desktop?: string
}

export function sessionsElsewhere(
  windows: Record<
    string,
    { id: string; type: string; desktopIndex?: number; props?: Record<string, any> }
  >,
  floats: Record<string, unknown> | undefined,
  desktops: ReadonlyArray<{ name?: string }>,
  activeDesktopIndex: number,
  t: (key: string, options: Record<string, unknown>) => string,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const w of Object.values(windows)) {
    const terminalId = w.props?.terminalId
    if (w.type !== "terminal" || typeof terminalId !== "string") continue
    if (floats?.[w.id] || typeof w.desktopIndex !== "number") continue
    if (w.desktopIndex === activeDesktopIndex) continue
    out.set(
      terminalId,
      desktops[w.desktopIndex]?.name ||
        t("terminal.window.desktopN", { defaultValue: "Desktop {{n}}", n: w.desktopIndex + 1 }),
    )
  }
  return out
}

export interface SessionGroup {
  key: SessionGroupKey
  rows: SessionRow[]
}

function groupOf(session: TerminalSession, me: string | undefined): SessionGroupKey {
  if (terminalSessionSpace(session) === "personal")
    return session.createdBy === me ? "mine" : "watching"
  return (session.createdBy ?? "").startsWith("agent:") ? "agents" : "shared"
}

const GROUP_ORDER: readonly SessionGroupKey[] = ["mine", "shared", "agents", "watching"]

export function sessionGroups(
  sessions: readonly TerminalSession[],
  me: string | undefined,
  openIds: ReadonlySet<string>,
  elsewhere?: ReadonlyMap<string, string>,
): SessionGroup[] {
  const rows: Record<SessionGroupKey, SessionRow[]> = {
    mine: [],
    shared: [],
    agents: [],
    watching: [],
  }
  for (const session of sessions)
    rows[groupOf(session, me)].push({
      session,
      open: openIds.has(session.terminalId),
      desktop: elsewhere?.get(session.terminalId),
    })
  return GROUP_ORDER.map((key) => ({ key, rows: rows[key] })).filter(
    (group) => group.rows.length > 0,
  )
}

export interface ToolbarState {
  consent: boolean
  canToggle: boolean
  canLetWatch: boolean
  canManage: boolean
  space: Space
  mine: boolean
  watchable: boolean
  watching: boolean
  agentOpened: boolean
  viewOnly: boolean
  typist: Typist
}

export function toolbarOf(
  session: TerminalSession,
  me: string | undefined,
  role: MemberRole = "write",
  now: number = Date.now(),
): ToolbarState {
  const actions = sessionActions(session, me, role)
  const space = terminalSessionSpace(session)
  const typist = typistOf(session, me)
  const mine = space === "personal" && session.createdBy === me
  const watching = space === "personal" && !mine
  return {
    consent: agentControlOf(session),
    canToggle: actions.includes("control") && !someoneElseTyping(session, me, now),
    canLetWatch: mine && actions.includes("manage"),
    canManage: actions.includes("manage"),
    space,
    mine,
    watchable: space === "personal" && session.watchable === true,
    watching,
    agentOpened: (session.createdBy ?? "").startsWith("agent:"),
    viewOnly: typist?.kind === "agent" || !actions.includes("use"),
    typist,
  }
}

export function inheritedSpace(session: TerminalSession | undefined): Space {
  if (!session || (session.createdBy ?? "").startsWith("agent:")) return "personal"
  return terminalSessionSpace(session)
}

export interface BashAppInfo {
  scope?: Space | null
  installedBy?: string | null
}

export type SharedOffer = { kind: "ready" } | { kind: "personal-bash"; mine: boolean }

export function sharedOfferOf(bash: BashAppInfo | null, me: string | undefined): SharedOffer {
  if (!bash || bash.scope !== "personal") return { kind: "ready" }
  return { kind: "personal-bash", mine: !!me && bash.installedBy === me }
}

export function offersPersonalAfter(
  failure: { code: string } | null,
  space: Space | undefined,
): boolean {
  return space === "shared" || failure?.code === "PERSONAL_APP"
}
