/**
 * DesktopStateApi — Typed client for the desktop-state domain
 *
 * Sends desktop-state.get / desktop-state.save requests via WsFramework.
 */

import type { Transport } from './transport/types'

export interface PersistedDesktopState {
  desktops: unknown[]
  windows?: Record<string, unknown>
}

export class DesktopStateApi {
  constructor(private readonly transport: Transport) {}

  async get(workspaceId: string): Promise<PersistedDesktopState | null> {
    const res = await this.transport.request<{ state: PersistedDesktopState | null }>(
      'desktop-state.get',
      { workspaceId },
    )
    return res.state ?? null
  }

  async save(
    workspaceId: string,
    desktops: unknown[],
    windows?: Record<string, unknown>,
  ): Promise<void> {
    await this.transport.request<{ ok: boolean }>('desktop-state.save', {
      workspaceId,
      desktops,
      windows,
    })
  }
}
