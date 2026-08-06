/**
 * Session Trace deep-link — /admin/trace/[id]  (A5.5 / TER-672).
 *
 * "Paste the trace in the incident" is basic ops. This shareable URL opens (or
 * focuses) the Session Trace window pre-loaded with the given sessionUsageId —
 * the window already accepts the id as a prop and serialises its own state.
 */

import { useLocalSearchParams } from "expo-router"
import { useWindowLauncher } from "../../../../src/hooks"
import { useWorkspaceReady } from "../../workspaceContext"

export default function TraceRoute() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const isReady = useWorkspaceReady()

  useWindowLauncher(
    "session-trace",
    { sessionUsageId: id },
    (props) => props.sessionUsageId === id,
    isReady && !!id,
  )

  return null
}
