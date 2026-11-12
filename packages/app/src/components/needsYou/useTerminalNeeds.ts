/**
 * The terminals waiting for the person, across their workspaces (kept by
 * TerminalNeedsWatcher). Read by the general notices next to
 * usePendingPermissions.
 */

import { useMemo } from "react"
import { useNavbarStore } from "../../store/navbarStore"
import { selectTerminalNeeds, type TerminalNeed, useTerminalNeedsStore } from "./terminalNeeds"

export function useTerminalNeeds(): TerminalNeed[] {
  const feeds = useTerminalNeedsStore((s) => s.feeds)
  const workspaces = useNavbarStore((s) => s.workspaces)
  return useMemo(() => selectTerminalNeeds(feeds, workspaces), [feeds, workspaces])
}
