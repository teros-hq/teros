import type { Space } from "@teros/shared"
import { useEffect, useState } from "react"
import i18n from "../../i18n"
import { getTerosClient } from "../../services/terosClientSingleton"

export type SharedKind = "terminal" | "browser" | "app"

export const SPACE_ICON: Record<Space, string> = { personal: "lock-simple", shared: "users" }

export function spaceLabel(space: Space): string {
  return space === "shared"
    ? i18n.t("sharing.shared", { defaultValue: "Shared" })
    : i18n.t("sharing.personal", { defaultValue: "Personal" })
}

interface NoticeStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserStore(): NoticeStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function noticeKey(kind: SharedKind, workspaceId: string, userId: string): string {
  return `teros.sharing.notice.${kind}.${workspaceId}.${userId}`
}

export function sharedNoticeSeen(
  kind: SharedKind,
  workspaceId: string,
  userId: string,
  store: NoticeStore | null = browserStore(),
): boolean {
  try {
    return store?.getItem(noticeKey(kind, workspaceId, userId)) === "1"
  } catch {
    return false
  }
}

export function markSharedNoticeSeen(
  kind: SharedKind,
  workspaceId: string,
  userId: string,
  store: NoticeStore | null = browserStore(),
): void {
  try {
    store?.setItem(noticeKey(kind, workspaceId, userId), "1")
  } catch {
    return
  }
}

interface WorkspacePeople {
  members?: Array<{ status?: string; role?: string }>
}

export function othersIn(workspace: WorkspacePeople): number {
  return (workspace.members ?? []).filter((m) => (m.status ?? "active") === "active").length
}

const known = new Map<string, number>()

export function useWorkspaceOthers(
  workspaceId: string | null | undefined,
  me: string | undefined,
): number | null {
  const key = workspaceId && me ? `${workspaceId}:${me}` : ""
  const [others, setOthers] = useState<number | null>(key ? (known.get(key) ?? null) : null)
  useEffect(() => {
    if (!workspaceId || !me) return
    let live = true
    setOthers(known.get(key) ?? null)
    const client = getTerosClient()
    if (!client) {
      setOthers((prev) => prev ?? 0)
      return
    }
    client
      .getWorkspace(workspaceId)
      .then((workspace) => {
        const count = othersIn(workspace)
        known.set(key, count)
        if (live) setOthers(count)
      })
      .catch(() => {
        if (live) setOthers((prev) => prev ?? 0)
      })
    return () => {
      live = false
    }
  }, [workspaceId, me, key])
  return others
}
