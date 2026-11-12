/**
 * useNavbarRealtimeSync — Subscribes the NavBar to backend WS events that mutate
 * the lists the user sees (agents, workspaces, projects, apps, conversations)
 * and updates the navbarStore (or invokes caller callbacks) idempotently.
 *
 * Wires the events emitted by TER-304 (agent/workspace/project/app handlers
 * via PubSubService.broadcastToUser/broadcastToWorkspace) plus the existing
 * `channel_list_status` for conversations.
 *
 * Design decisions:
 *  - Direct store writes for agents/workspaces/apps — the navbarStore is the
 *    source of truth and is already shared across the NavBar tree.
 *  - Callbacks for conversations/projects — those still live as local state
 *    in `<Navbar/>` (top-10 + active/inactive/archived buckets), so the
 *    component-owned setters keep their custom logic.
 *  - `optsRef` pattern so callers can pass new callbacks each render without
 *    re-subscribing all listeners.
 *  - Skip events while `isLoaded === false` to avoid races with the in-flight
 *    `loadData()` overwriting the optimistic upsert with a stale list.
 */

import { useEffect, useRef } from 'react'
import { getTerosClient } from '../../services/terosClientSingleton'
import {
  type NavbarAgent,
  type NavbarApp,
  type NavbarWorkspace,
  useNavbarStore,
} from '../../store/navbarStore'
import { useWorkspaceStore } from '../../store/workspaceStore'

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

export interface NavbarRealtimeConversation {
  channelId: string
  title?: string
  agentId?: string
  agentName?: string
  agentAvatarUrl?: string
  lastMessageAt?: string
  /** Where the channel belongs (CHAN-REQ-11); absent on `deleted`. */
  workspaceId?: string | null
  headless?: boolean
  originChannelId?: string | null
}

export interface NavbarRealtimeProject {
  projectId: string
  name?: string
  workspaceId?: string
}

export interface UseNavbarRealtimeSyncOptions {
  /** Called when a channel is created/updated/deleted (forwards `channel_list_status`). */
  onConversationChange?: (
    action: 'created' | 'updated' | 'deleted',
    payload: NavbarRealtimeConversation,
  ) => void
  /** Called when a project is created/updated/deleted in the active workspace. */
  onProjectChange?: (
    action: 'created' | 'updated' | 'deleted',
    payload: NavbarRealtimeProject,
  ) => void
}

// ----------------------------------------------------------------------------
// Helpers — normalise the raw WS payload into Navbar* shapes
// ----------------------------------------------------------------------------

function toNavbarAgent(raw: any): NavbarAgent {
  return {
    agentId: raw.agentId,
    name: raw.fullName ?? raw.name,
    role: raw.role,
    avatarUrl: raw.avatarUrl,
    coreId: raw.coreId,
    workspaceId: raw.workspaceId,
  }
}

function toNavbarWorkspace(raw: any): NavbarWorkspace {
  return {
    workspaceId: raw.workspaceId,
    name: raw.name,
    role: raw.role ?? 'owner',
    volumeId: raw.volumeId,
    appearance: raw.appearance,
    type: raw.type,
  }
}

function toNavbarApp(raw: any): NavbarApp {
  return {
    appId: raw.appId,
    name: raw.name,
    mcaId: raw.mcaId,
    // Backend payload doesn't carry mcaName today — fall back to mcaId so the
    // store stays well-typed; the next full re-fetch will hydrate the real name.
    mcaName: raw.mcaName ?? raw.mcaId,
    description: raw.description ?? '',
    icon: raw.icon,
    color: raw.color,
    category: raw.category ?? 'unknown',
    status: raw.status ?? 'active',
  }
}

// ----------------------------------------------------------------------------
// Hook
// ----------------------------------------------------------------------------

export function useNavbarRealtimeSync(opts: UseNavbarRealtimeSyncOptions = {}): void {
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const client = getTerosClient()

    const isReady = () => useNavbarStore.getState().isLoaded

    // ---------------- Agents ----------------
    const handleAgentCreated = (data: any) => {
      if (!isReady() || !data?.agent) return
      useNavbarStore.getState().addAgent(toNavbarAgent(data.agent))
    }
    const handleAgentUpdated = (data: any) => {
      if (!isReady() || !data?.agent?.agentId) return
      useNavbarStore.getState().updateAgent(data.agent.agentId, toNavbarAgent(data.agent))
    }
    const handleAgentDeleted = (data: any) => {
      if (!isReady() || !data?.agentId) return
      useNavbarStore.getState().removeAgent(data.agentId)
    }

    // ---------------- Workspaces ----------------
    const handleWorkspaceCreated = (data: any) => {
      if (!isReady() || !data?.workspace) return
      useNavbarStore.getState().addWorkspace(toNavbarWorkspace(data.workspace))
    }
    const handleWorkspaceUpdated = (data: any) => {
      if (!isReady() || !data?.workspace?.workspaceId) return
      useNavbarStore
        .getState()
        .updateWorkspace(data.workspace.workspaceId, toNavbarWorkspace(data.workspace))
    }
    const handleWorkspaceArchived = (data: any) => {
      if (!isReady() || !data?.workspaceId) return
      useNavbarStore.getState().removeWorkspace(data.workspaceId)
    }
    // MUW-REQ-20/22: the user was removed from (or left) a workspace — same
    // effect on the sidebar as an archive: the workspace disappears live.
    const handleMembershipRemoved = handleWorkspaceArchived

    // ---------------- Apps ----------------
    // MUW-REQ-13: app pushes go to the whole workspace, but a member only sees
    // shared apps plus their own. Instead of trusting the payload (which would
    // surface another member's private app in the sidebar), re-fetch the
    // server-filtered list of the active workspace. Coalesced per burst.
    let appsRefetch: ReturnType<typeof setTimeout> | null = null
    const refetchApps = () => {
      if (!isReady()) return
      if (appsRefetch) clearTimeout(appsRefetch)
      appsRefetch = setTimeout(async () => {
        appsRefetch = null
        const wsId = useWorkspaceStore.getState().activeWorkspaceId
        if (!wsId) return
        try {
          const { apps } = await client.workspace.listWorkspaceApps(wsId)
          useNavbarStore.getState().setApps(
            (apps ?? []).map((app: any) => toNavbarApp({ ...app, mcaName: app.mcaName ?? app.mcpName ?? app.mcaId })),
          )
        } catch (err) {
          console.warn('[NavbarRealtime] apps refetch failed:', err)
        }
      }, 250)
    }
    const handleAppInstalled = (data: any) => {
      if (!data?.app) return
      refetchApps()
    }
    const handleAppUpdated = (data: any) => {
      if (!data?.app?.appId) return
      refetchApps()
    }
    const handleAppUninstalled = (data: any) => {
      if (!isReady() || !data?.appId) return
      useNavbarStore.getState().removeApp(data.appId)
    }

    // ---------------- Projects (callback) ----------------
    const handleProjectChange =
      (action: 'created' | 'updated' | 'deleted') => (data: any) => {
        if (!isReady()) return
        const cb = optsRef.current.onProjectChange
        if (!cb) return
        // Filter to active workspace — projects are workspace-scoped in the NavBar.
        const activeWs = useWorkspaceStore.getState().activeWorkspaceId
        const evWs =
          data?.project?.workspaceId ??
          data?.workspaceId ??
          data?.board?.workspaceId
        if (activeWs && evWs && evWs !== activeWs) return

        if (action === 'deleted') {
          if (!data?.projectId) return
          cb('deleted', { projectId: data.projectId, workspaceId: evWs })
          return
        }
        if (!data?.project?.projectId) return
        cb(action, {
          projectId: data.project.projectId,
          name: data.project.name,
          workspaceId: data.project.workspaceId,
        })
      }

    // ---------------- Conversations (existing channel_list_status) ----------------
    const handleChannelListStatus = (data: any) => {
      if (!isReady()) return
      const cb = optsRef.current.onConversationChange
      if (!cb) return
      const action = data?.action as 'created' | 'updated' | 'deleted' | undefined
      if (action !== 'created' && action !== 'updated' && action !== 'deleted') return

      if (action === 'deleted') {
        if (!data?.channelId) return
        cb('deleted', { channelId: data.channelId })
        return
      }
      const ch = data?.channel
      if (!ch?.channelId) return
      cb(action, {
        channelId: ch.channelId,
        title: ch.title ?? ch.name,
        agentId: ch.agentId,
        agentName: ch.agentName,
        agentAvatarUrl: ch.agentAvatarUrl,
        lastMessageAt: ch.lastMessageAt ?? ch.updatedAt,
        workspaceId: ch.workspaceId,
        headless: ch.headless,
        originChannelId: ch.originChannelId,
      })
    }

    const handleProjectCreated = handleProjectChange('created')
    const handleProjectUpdated = handleProjectChange('updated')
    const handleProjectDeleted = handleProjectChange('deleted')

    client.on('agent.created', handleAgentCreated)
    client.on('agent.updated', handleAgentUpdated)
    client.on('agent.deleted', handleAgentDeleted)
    client.on('workspace.created', handleWorkspaceCreated)
    client.on('workspace.updated', handleWorkspaceUpdated)
    client.on('workspace.archived', handleWorkspaceArchived)
    client.on('workspace.membership_removed', handleMembershipRemoved)
    client.on('app.installed', handleAppInstalled)
    client.on('app.updated', handleAppUpdated)
    client.on('app.uninstalled', handleAppUninstalled)
    client.on('project.created', handleProjectCreated)
    client.on('project.updated', handleProjectUpdated)
    client.on('project.deleted', handleProjectDeleted)
    client.on('channel_list_status', handleChannelListStatus)

    return () => {
      client.off('agent.created', handleAgentCreated)
      client.off('agent.updated', handleAgentUpdated)
      client.off('agent.deleted', handleAgentDeleted)
      client.off('workspace.created', handleWorkspaceCreated)
      client.off('workspace.updated', handleWorkspaceUpdated)
      client.off('workspace.archived', handleWorkspaceArchived)
      client.off('workspace.membership_removed', handleMembershipRemoved)
      client.off('app.installed', handleAppInstalled)
      client.off('app.updated', handleAppUpdated)
      client.off('app.uninstalled', handleAppUninstalled)
      if (appsRefetch) clearTimeout(appsRefetch)
      client.off('project.created', handleProjectCreated)
      client.off('project.updated', handleProjectUpdated)
      client.off('project.deleted', handleProjectDeleted)
      client.off('channel_list_status', handleChannelListStatus)
    }
  }, [])
}
