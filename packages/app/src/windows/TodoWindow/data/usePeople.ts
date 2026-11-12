/**
 * The agents and people of a workspace, for assignment (workspace.list-members:
 * the workspace's agents + the caller's personal agents, and the owner +
 * members). Cached per workspace for the session; refreshed on mount.
 */
import { useEffect, useMemo, useState } from "react"
import { getTerosClient } from "../../../services/terosClientSingleton"
import type { WorkspaceUnifiedMember } from "../../../services/WorkspaceApi"
import { useAuthStore } from "../../../store/authStore"
import type { Assignee } from "../model/types"

export interface Person {
  kind: "agent" | "user"
  id: string
  name: string
  avatarUrl?: string
  role?: string
}

const cache = new Map<string, Person[]>()
const inflight = new Map<string, Promise<Person[]>>()
const listeners = new Set<() => void>()

function load(workspaceId: string): Promise<Person[]> {
  let p = inflight.get(workspaceId)
  if (!p) {
    p = getTerosClient()
      .workspace.listMembers(workspaceId)
      .then(({ members }: { members: WorkspaceUnifiedMember[] }) => {
        const people: Person[] = members.map((m) => ({
          kind: m.type === "agent" ? "agent" : "user",
          id: m.id,
          name: m.name || m.fullName || m.email || m.id,
          avatarUrl: m.avatarUrl,
          role: m.role,
        }))
        cache.set(workspaceId, people)
        listeners.forEach((l) => l())
        return people
      })
      .finally(() => inflight.delete(workspaceId))
    inflight.set(workspaceId, p)
  }
  return p
}

export function usePeople(workspaceId: string | null | undefined) {
  const [, bump] = useState(0)
  const me = useAuthStore((s) => s.user?.userId ?? null)
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    listeners.add(l)
    if (workspaceId) load(workspaceId).catch(() => {})
    return () => {
      listeners.delete(l)
    }
  }, [workspaceId])
  const people = (workspaceId && cache.get(workspaceId)) || []
  return useMemo(() => {
    const byKey = new Map(people.map((p) => [`${p.kind}:${p.id}`, p]))
    const find = (a: Assignee | null | undefined) => (a ? byKey.get(`${a.kind}:${a.id}`) : undefined)
    return { people, me, find }
  }, [people, me])
}
