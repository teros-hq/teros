/**
 * NavbarApi — typed client for the `navbar` domain (NAV spec v2.0.0): the two
 * anchored zones of the navbar.
 *
 * @spec NAV-REQ-3, NAV-REQ-10, NAV-REQ-17
 */
import type { Transport } from './transport/types'

export type NavbarPinScope = 'workspace' | 'personal'

export interface NavbarPinWindow {
  type: string
  props: Record<string, any>
}

/** @spec NAV-REQ-2 */
export interface NavbarPinData {
  pinId: string
  workspaceId: string
  scope: NavbarPinScope
  userId?: string
  global?: boolean
  window: NavbarPinWindow
  key: string
  label?: string
  labelKey?: string
  icon?: string
  display: 'row' | 'widget'
  enabled: boolean
  order: number
  factory: boolean
  createdBy: { kind: 'user' | 'agent' | 'system'; id: string }
  createdAt: string
  updatedAt: string
}

export interface PinWindowInput {
  workspaceId: string
  scope: NavbarPinScope
  window: NavbarPinWindow
  label?: string
  icon?: string
  display?: 'row' | 'widget'
  position?: { before?: string }
}

export class NavbarApi {
  constructor(private transport: Transport) {}

  /** @spec NAV-REQ-3 */
  list(workspaceId: string): Promise<{ workspaceId: string; pins: NavbarPinData[] }> {
    return this.transport.request('navbar.list', { workspaceId })
  }

  /** @spec NAV-REQ-2 */
  pin(input: PinWindowInput): Promise<{ pin: NavbarPinData; existed: boolean }> {
    return this.transport.request('navbar.pin', { ...input })
  }

  /** @spec NAV-REQ-10 */
  unpin(pinId: string): Promise<{ success: boolean; pin: NavbarPinData }> {
    return this.transport.request('navbar.unpin', { pinId })
  }

  /** @spec NAV-REQ-10 */
  update(
    pinId: string,
    patch: { label?: string; display?: 'row' | 'widget'; enabled?: boolean },
  ): Promise<{ pin: NavbarPinData }> {
    return this.transport.request('navbar.update', { pinId, ...patch })
  }

  /** @spec NAV-REQ-5 */
  move(
    pinId: string,
    to: { workspaceId: string; scope?: NavbarPinScope; global?: boolean },
  ): Promise<{ pin: NavbarPinData }> {
    return this.transport.request('navbar.move', { pinId, ...to })
  }

  /** @spec NAV-REQ-10 */
  reorder(workspaceId: string, scope: NavbarPinScope, pinIds: string[]): Promise<{ success: boolean }> {
    return this.transport.request('navbar.reorder', { workspaceId, scope, pinIds })
  }
}
