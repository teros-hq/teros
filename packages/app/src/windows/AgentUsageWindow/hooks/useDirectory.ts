/**
 * `useDirectory()` — loads + caches the cascading filter directory for the
 * agent-usage dashboard.
 *
 * The directory is the union of users / agents / workspaces accessible to
 * the current admin, narrowed by the active filter set (backend computes
 * `workspaces.members + ownerId + agents.workspaceId` access checks).
 * Provider + triggerKind are fixed enums and DON'T affect this fetch.
 *
 * Closes the Data Clumps smell — instead of dragging `userIdToName`,
 * `agentIdToName`, `workspaceIdToName`, `userOptions`, `agentOptions`,
 * `workspaceOptions` as 6 separate variables through dependency arrays,
 * the directory ships as one struct with one fetch lifecycle.
 *
 * Behavior preserved from the inline version:
 *   - Sorts options alphabetically by label.
 *   - Tolerates client disconnect: re-runs on `'connected'` event.
 *   - Swallows fetch errors (warn + empty directory). The dashboard
 *     degrades gracefully — filters become id-only dropdowns.
 */

import { useEffect, useState } from "react"
import type { TerosClient } from "../../../services/TerosClient"

export interface FilterDirectory {
  userIdToName: Map<string, string>
  /** Per-user real agent-hours plan limit for the dashboard quota (TER-628). */
  userIdToLimit: Map<string, number>
  agentIdToName: Map<string, string>
  workspaceIdToName: Map<string, string>
  userOptions: { value: string; label: string }[]
  agentOptions: { value: string; label: string }[]
  workspaceOptions: { value: string; label: string }[]
}

export function emptyDirectory(): FilterDirectory {
  return {
    userIdToName: new Map(),
    userIdToLimit: new Map(),
    agentIdToName: new Map(),
    workspaceIdToName: new Map(),
    userOptions: [],
    agentOptions: [],
    workspaceOptions: [],
  }
}

export interface DirectoryFilters {
  userId?: string
  agentId?: string
  workspaceId?: string
}

/**
 * Hook returns the live directory object. Re-fetches whenever any of the
 * three cascading filters change OR the client reconnects.
 */
export function useDirectory(
  client: TerosClient,
  filters: DirectoryFilters,
): FilterDirectory {
  const [directory, setDirectory] = useState<FilterDirectory>(emptyDirectory)
  const { userId, agentId, workspaceId } = filters

  useEffect(() => {
    const loadDirectory = async () => {
      try {
        const res = await client.admin.agentUsageListAccessibleEntities({
          userId: userId || undefined,
          agentId: agentId || undefined,
          workspaceId: workspaceId || undefined,
        })
        const userIdToName = new Map<string, string>()
        const userIdToLimit = new Map<string, number>()
        const userOptions: { value: string; label: string }[] = []
        for (const u of res.users) {
          userIdToName.set(u.userId, u.name)
          userIdToLimit.set(u.userId, u.agentHoursLimit)
          userOptions.push({ value: u.userId, label: u.name })
        }
        const agentIdToName = new Map<string, string>()
        const agentOptions: { value: string; label: string }[] = []
        for (const a of res.agents) {
          agentIdToName.set(a.agentId, a.name)
          agentOptions.push({ value: a.agentId, label: a.name })
        }
        const workspaceIdToName = new Map<string, string>()
        const workspaceOptions: { value: string; label: string }[] = []
        for (const w of res.workspaces) {
          workspaceIdToName.set(w.workspaceId, w.name)
          workspaceOptions.push({ value: w.workspaceId, label: w.name })
        }
        userOptions.sort((a, b) => a.label.localeCompare(b.label))
        agentOptions.sort((a, b) => a.label.localeCompare(b.label))
        workspaceOptions.sort((a, b) => a.label.localeCompare(b.label))
        setDirectory({
          userIdToName,
          userIdToLimit,
          agentIdToName,
          workspaceIdToName,
          userOptions,
          agentOptions,
          workspaceOptions,
        })
      } catch (err) {
        console.warn("[AgentUsageWindow] Failed to load directory", err)
      }
    }
    if (client.isConnected()) {
      loadDirectory()
    } else {
      const onConnected = () => {
        loadDirectory()
        client.off("connected", onConnected)
      }
      client.on("connected", onConnected)
    }
  }, [client, userId, agentId, workspaceId])

  return directory
}
