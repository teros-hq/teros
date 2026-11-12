/**
 * Launcher model — which window types the launcher offers to a viewer, and
 * in which section. Pure (no React), so it is tested against the real
 * registry for each audience.
 */
import {
  canSeeWindow,
  type WindowTypeDefinition,
  type WindowViewer,
} from "../../services/windowRegistry"

export type SectionKey = "start" | "work" | "apps" | "account" | "admin" | "tools"

export const SECTION_ORDER: SectionKey[] = ["start", "work", "apps", "account", "admin", "tools"]

/**
 * Window type → section. The launcher is for OPENING something; navigation
 * lives in the sidebar. A type with no section here is NOT shown (fail
 * closed — nothing slips into the launcher by default).
 */
export const SECTION_OF: Record<string, SectionKey> = {
  // Start (Pablo, 2026-11-03): new conversation (rendered by the launcher
  // itself), then browser, home and tasks. Creating an agent is work.
  browser: "start",
  home: "start",
  todo: "start",
  "create-agent": "work",
  conversations: "work",
  "archived-conversations": "work",
  "pending-approvals": "work",
  board: "work",
  // Agents and Projects lists (NAV-REQ-12): launchable without context.
  agents: "work",
  projects: "work",
  flowList: "work",
  automate: "work",
  apps: "apps",
  catalog: "apps",
  skills: "apps",
  academy: "apps",
  profile: "account",
  providers: "account",
  workspaces: "account",
  terminal: "tools",
  "file-browser": "tools",
  // Admin (audience "admin" — only admins ever see them)
  users: "admin",
  mcas: "admin",
  "agent-cores": "admin",
  monitoring: "admin",
  "model-health": "admin",
  "agent-usage": "admin",
  "billing-requests": "admin",
  "billing-teams": "admin",
  "billing-audit": "admin",
  "feature-flags": "admin",
  "teros-provider": "admin",
  "feedback-admin": "admin",
  "latitude-signals": "admin",
  console: "admin",
}

/**
 * Explicit order inside a section; types not listed follow in registry order.
 * Start reads: New conversation · Browser · Home · Tasks.
 */
export const SECTION_ITEM_ORDER: Partial<Record<SectionKey, string[]>> = {
  start: ["browser", "home", "todo"],
  work: ["conversations", "todo", "projects", "board", "agents", "create-agent"],
}

/** Sort a section's definitions by SECTION_ITEM_ORDER, keeping unknown types after, in their given order. */
export function orderInSection<T extends { type: string }>(section: SectionKey, defs: T[]): T[] {
  const order = SECTION_ITEM_ORDER[section]
  if (!order) return defs
  const rank = (t: string) => {
    const i = order.indexOf(t)
    return i === -1 ? order.length : i
  }
  return [...defs].sort((a, b) => rank(a.type) - rank(b.type))
}

/** Admin windows open without context, so they belong in the launcher even
 *  though they don't set `isLauncher` (the sidebar opens them too). */
export const ADMIN_LAUNCHABLE = new Set(
  Object.entries(SECTION_OF)
    .filter(([, sec]) => sec === "admin")
    .map(([type]) => type),
)

/**
 * The window types the launcher shows to this viewer: launchable (or an
 * admin window), placed in a section, inside the viewer's audience, and with
 * their feature flag on.
 */
export function launcherTypes(
  defs: WindowTypeDefinition<any>[],
  viewer: WindowViewer,
  isFlagOn: (flag: string) => boolean,
): WindowTypeDefinition<any>[] {
  return defs.filter((def) => {
    if (!def.isLauncher && !ADMIN_LAUNCHABLE.has(def.type)) return false
    if (!SECTION_OF[def.type]) return false
    if (!canSeeWindow(def, viewer)) return false
    if (def.featureFlag && !isFlagOn(def.featureFlag)) return false
    return true
  })
}
