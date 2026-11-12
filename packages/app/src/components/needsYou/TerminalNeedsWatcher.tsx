/**
 * TerminalNeedsWatcher — mounted once in the workspace layout. Keeps the live
 * terminal sessions of every workspace the person can write in (the shared,
 * ref-counted terminal.watch of terminalSessions.ts, so the active
 * workspace's watch is the Terminal windows' own) in useTerminalNeedsStore,
 * where the general notices read the ones waiting for an answer.
 */

import { useEffect, useMemo } from "react"
import { useNavbarStore } from "../../store/navbarStore"
import { useTerminalSessions } from "../../windows/TerminalWindow/terminalSessions"
import { useTerminalNeedsStore, writableWorkspaceIds } from "./terminalNeeds"

function WorkspaceFeed({ workspaceId }: { workspaceId: string }) {
  const { sessions, loaded } = useTerminalSessions(workspaceId)
  useEffect(() => {
    if (loaded) useTerminalNeedsStore.getState().setFeed(workspaceId, sessions)
  }, [workspaceId, sessions, loaded])
  useEffect(() => () => useTerminalNeedsStore.getState().dropFeed(workspaceId), [workspaceId])
  return null
}

export function TerminalNeedsWatcher() {
  const workspaces = useNavbarStore((s) => s.workspaces)
  const key = writableWorkspaceIds(workspaces).join(",")
  const ids = useMemo(() => (key ? key.split(",") : []), [key])
  return (
    <>
      {ids.map((id) => (
        <WorkspaceFeed key={id} workspaceId={id} />
      ))}
    </>
  )
}
