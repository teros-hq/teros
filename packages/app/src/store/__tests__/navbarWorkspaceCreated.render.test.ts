/**
 * workspace.created realtime chain — regression test
 *
 * Bug (reported by Pablo): when an agent creates a workspace via the MCA
 * teros-core create-workspace tool, the UI never refreshed — the new workspace
 * only appeared after a full page reload. Root cause: the backend only
 * broadcast `workspace.created` from the WS domain handler, not from
 * WorkspaceService.createWorkspace (the MCA path).
 *
 * Fix: WorkspaceService.createWorkspace now broadcasts `workspace.created` to
 * the owner's sessions on every creation path. This test pins the FRONTEND
 * half of the chain:
 *
 *   transport event → TerosClient eventBus forwarding (whitelist) →
 *   navbarStore.addWorkspace idempotent upsert
 *
 * If `workspace.created` is ever dropped from the client forwarding whitelist,
 * or addWorkspace loses its idempotency guard, this test fails.
 *
 * Runner: vitest (render harness — jsdom + react-native-web aliases in
 * vitest.config.ts). The real storage module is used: on web it selects the
 * LocalStorageDriver, which is backed by jsdom's window.localStorage.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { TerosClientFactory } from '../../services/factory'
import { useNavbarStore } from '../../store/navbarStore'

type NavbarWorkspace = import('../../store/navbarStore').NavbarWorkspace

describe('workspace.created realtime chain', () => {
  beforeEach(() => {
    useNavbarStore.getState().reset()
  })

  it('TerosClient forwards workspace.created from transport to client.on listeners', () => {
    const factory = new TerosClientFactory()
    const { client, transport } = factory.createMockClient()

    const received: any[] = []
    client.on('workspace.created', (data: any) => received.push(data))

    const payload = {
      type: 'workspace.created',
      workspace: {
        workspaceId: 'work_abc123',
        name: 'Agent-made WS',
        volumeId: 'vol_1',
        role: 'owner',
        status: 'active',
        type: 'shared',
        createdAt: new Date().toISOString(),
      },
    }
    transport.simulateEvent('workspace.created', payload)

    expect(received).toHaveLength(1)
    expect(received[0].workspace.workspaceId).toBe('work_abc123')
  })

  it('navbarStore.addWorkspace upserts idempotently — duplicate events do not duplicate entries', () => {
    const ws: NavbarWorkspace = {
      workspaceId: 'work_abc123',
      name: 'Agent-made WS',
      role: 'owner',
      volumeId: 'vol_1',
      type: 'shared',
    }

    const store = useNavbarStore.getState()
    store.addWorkspace(ws)
    // Simulate the double-delivery case: optimistic UI insert + backend
    // broadcast, or legacy WS sendMessage + service-level broadcast.
    store.addWorkspace(ws)
    store.addWorkspace({ ...ws })

    const workspaces = useNavbarStore.getState().workspaces
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0].workspaceId).toBe('work_abc123')
  })

  it('full chain: forwarded event upserted into navbarStore twice yields one entry', () => {
    const factory = new TerosClientFactory()
    const { client, transport } = factory.createMockClient()

    // Mirror what useNavbarRealtimeSync.handleWorkspaceCreated does.
    const toNavbarWorkspace = (raw: any): NavbarWorkspace => ({
      workspaceId: raw.workspaceId,
      name: raw.name,
      role: raw.role ?? 'owner',
      volumeId: raw.volumeId,
      appearance: raw.appearance,
      type: raw.type,
    })
    client.on('workspace.created', (data: any) => {
      if (!data?.workspace) return
      useNavbarStore.getState().addWorkspace(toNavbarWorkspace(data.workspace))
    })

    const payload = {
      type: 'workspace.created',
      workspace: {
        workspaceId: 'work_xyz789',
        name: 'Fresh WS',
        volumeId: 'vol_2',
        role: 'owner',
        status: 'active',
        type: 'shared',
        createdAt: new Date().toISOString(),
      },
    }

    // Same event delivered twice (e.g. domain handler + service broadcast).
    transport.simulateEvent('workspace.created', payload)
    transport.simulateEvent('workspace.created', payload)

    const workspaces = useNavbarStore.getState().workspaces
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]).toMatchObject({
      workspaceId: 'work_xyz789',
      name: 'Fresh WS',
      role: 'owner',
      type: 'shared',
    })
  })
})
