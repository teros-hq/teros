/**
 * The terminals waiting for the person, across their workspaces (kept by
 * TerminalNeedsWatcher). Read by the general notices next to
 * usePendingPermissions.
 */

import { useMemo } from "react"
import { useAuthStore } from "../../store/authStore"
import { useNavbarStore } from "../../store/navbarStore"
import { selectTerminalNeeds, type TerminalNeed, useTerminalNeedsStore } from "./terminalNeeds"

export function useTerminalNeeds(): TerminalNeed[] {
  const feeds = useTerminalNeedsStore((s) => s.feeds)
  const workspaces = useNavbarStore((s) => s.workspaces)
  const me = useAuthStore((s) => s.user?.userId)
  return useMemo(() => selectTerminalNeeds(feeds, workspaces, me ?? ""), [feeds, workspaces, me])
}
