import { TERMINAL_DRIVER_IDLE_MS, terminalSessionSpace } from "@teros/shared"
import i18n from "../../i18n"
import type { TerminalSession } from "./terminalSessions"

export function firstName(name: string | undefined | null): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? ""
}

export function isUnnamedAgent(
  p: { id?: string; name?: string | null } | null | undefined,
): boolean {
  if (!p) return false
  const name = (p.name ?? "").trim()
  return name === "" || (name === "Agent" && (p.id ?? "").startsWith("agent:"))
}

export function agentDisplayName(
  p: { id?: string; name?: string | null } | null | undefined,
): string {
  return isUnnamedAgent(p) || !p
    ? i18n.t("terminal.window.anAgent", { defaultValue: "An agent" })
    : firstName(p.name)
}

export type Typist =
  | { kind: "you" }
  | { kind: "person"; name: string }
  | { kind: "agent"; name: string }
  | null

export function typistOf(session: Pick<TerminalSession, "driver">, me: string | undefined): Typist {
  const d = session.driver
  if (!d || d.kind === "none") return null
  if (d.kind === "agent") return { kind: "agent", name: agentDisplayName(d) }
  if (d.id && d.id === me) return { kind: "you" }
  return { kind: "person", name: firstName(d.name) || "?" }
}

export function typistLabel(typist: Typist): string {
  if (!typist || typist.kind === "you") return ""
  return i18n.t("terminal.window.someoneTypes", {
    defaultValue: "{{name}} is typing",
    name: typist.name,
  })
}

export type Opener = "you" | "member" | "agent"

export function openerOf(
  session: Pick<TerminalSession, "createdBy">,
  me: string | undefined,
): Opener {
  const by = session.createdBy ?? ""
  if (by.startsWith("agent:")) return "agent"
  return by === me ? "you" : "member"
}

export type TypingSession = Pick<TerminalSession, "driver" | "lastInput"> &
  Partial<Pick<TerminalSession, "watchers">>

export function busyTypist(
  session: TypingSession,
  me: string | undefined,
  now: number = Date.now(),
): { id: string; name?: string } | null {
  const recent = (at: number | null | undefined) => !!at && now - at <= TERMINAL_DRIVER_IDLE_MS
  const d = session.driver
  if (d?.kind === "human" && d.id && d.id !== me) {
    const last = session.lastInput
    const typedAt = last?.kind === "human" && last.id === d.id ? last.at : 0
    if (recent(Math.max(d.since ?? 0, typedAt))) return { id: d.id, name: d.name }
  }
  for (const w of session.watchers ?? []) {
    if (typeof w === "string" || w.kind !== "human" || w.id === me) continue
    if (recent(w.typingAt)) return { id: w.id, name: w.name }
  }
  return null
}

export function someoneElseTyping(
  session: TypingSession,
  me: string | undefined,
  now: number = Date.now(),
): boolean {
  return busyTypist(session, me, now) !== null
}

export function mayToggleAgent(
  session: TypingSession & Pick<TerminalSession, "createdBy" | "space">,
  me: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!me) return false
  const personal = terminalSessionSpace(session) === "personal"
  if (personal && session.createdBy !== me) return false
  return !someoneElseTyping(session, me, now)
}

export function agentControlOf(
  session: Pick<TerminalSession, "agentControl" | "createdBy">,
): boolean {
  if (typeof session.agentControl === "boolean") return session.agentControl
  return (session.createdBy ?? "").startsWith("agent:")
}
