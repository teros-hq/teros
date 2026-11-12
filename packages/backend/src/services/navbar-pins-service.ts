/**
 * NavbarPinsService — the two anchored zones of the navbar (NAV spec v2.0.0).
 *
 * A pin is a serialized window that lives in the rail instead of in a tab.
 * Workspace-scope pins are identical for every member and edited by owner/admins;
 * personal pins belong to one user and are local to the workspace they were
 * created in, or global (stored in the user's private workspace).
 *
 * @spec NAV-REQ-2, NAV-REQ-3, NAV-REQ-4, NAV-REQ-5, NAV-REQ-6, NAV-REQ-7, NAV-REQ-17
 */
import type { Db } from 'mongodb'
import { nanoid } from 'nanoid'
import type { NavbarPin, NavbarPinScope, NavbarPinWindow } from '../types/database'
import { COLLECTIONS } from '../db/collections'
import type { WorkspaceService } from './workspace-service'
import type { PubSubService } from './pubsub-service'
import type { UserId } from '@teros/shared'

/** @spec NAV-REQ-7 — factory pins, in rail order. labelKey is resolved by the client (i18n). */
export const FACTORY_PINS: ReadonlyArray<{ type: string; icon: string; labelKey: string }> = [
  { type: 'todo', icon: 'list-checks', labelKey: 'nav.todo' },
  { type: 'apps', icon: 'cube', labelKey: 'nav.apps' },
  { type: 'catalog', icon: 'storefront', labelKey: 'nav.catalog' },
  { type: 'skills', icon: 'books', labelKey: 'nav.skills' },
  { type: 'agents', icon: 'robot', labelKey: 'nav.agents' },
  { type: 'projects', icon: 'kanban', labelKey: 'nav.projects' },
  { type: 'conversations', icon: 'chats-circle', labelKey: 'nav.conversations' },
  { type: 'automate', icon: 'lightning', labelKey: 'nav.automate' },
  { type: 'academy', icon: 'graduation-cap', labelKey: 'nav.academy' },
]

/** A pin that switches workspace (NAV-REQ-5). Not a registry window: `workspace` is the settings window. */
export const WORKSPACE_LINK = 'workspace-link'

export interface PinInput {
  workspaceId: string
  scope: NavbarPinScope
  window: NavbarPinWindow
  label?: string
  icon?: string
  display?: 'row' | 'widget'
  /** Insert before this pin (same zone); appended when absent. */
  position?: { before?: string }
  createdBy?: NavbarPin['createdBy']
}

export class NavbarPinError extends Error {
  constructor(public readonly code: 'ACCESS_DENIED' | 'PIN_NOT_FOUND' | 'INVALID_WINDOW' | 'NO_PRIVATE_WORKSPACE', message: string) {
    super(message)
    this.name = 'NavbarPinError'
  }
}

/** Stable identity of a window: type + its serialized props (key order independent). */
export function pinKey(window: NavbarPinWindow): string {
  const props = window.props ?? {}
  const sorted = Object.keys(props)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      if (props[k] !== undefined) acc[k] = props[k]
      return acc
    }, {})
  return `${window.type}:${JSON.stringify(sorted)}`
}

export class NavbarPinsService {
  constructor(
    private readonly db: Db,
    private readonly workspaceService: WorkspaceService,
    private readonly pubSubService: PubSubService | null = null,
  ) {}

  private get pins() {
    return this.db.collection<NavbarPin>(COLLECTIONS.navbarPins)
  }

  /** @spec NAV-REQ-4 — global personal pins live in the user's private workspace. */
  private async privateWorkspaceId(userId: string): Promise<string> {
    const user = await this.db.collection('users').findOne({ userId }, { projection: { privateWorkspaceId: 1 } })
    const id = user?.privateWorkspaceId as string | undefined
    if (!id) throw new NavbarPinError('NO_PRIVATE_WORKSPACE', `User ${userId} has no private workspace`)
    return id
  }

  private async assertAccess(workspaceId: string, userId: string): Promise<void> {
    if (!(await this.workspaceService.canAccess(workspaceId, userId))) {
      throw new NavbarPinError('ACCESS_DENIED', 'You do not have access to this workspace')
    }
  }

  /** @spec NAV-REQ-3, NAV-REQ-4 — who may mutate a pin. */
  private async assertCanEdit(pin: Pick<NavbarPin, 'workspaceId' | 'scope' | 'userId'>, userId: string): Promise<void> {
    if (pin.scope === 'workspace') {
      if (!(await this.workspaceService.canAdmin(pin.workspaceId, userId))) {
        throw new NavbarPinError('ACCESS_DENIED', 'Only the workspace owner or an admin can edit the workspace zone')
      }
      return
    }
    if (pin.userId !== userId) throw new NavbarPinError('ACCESS_DENIED', 'This pin belongs to another user')
    await this.assertAccess(pin.workspaceId, userId)
  }

  private notify(pin: Pick<NavbarPin, 'workspaceId' | 'scope' | 'userId'>): void {
    if (!this.pubSubService) return
    const event = { type: 'navbar.pins_changed', workspaceId: pin.workspaceId, scope: pin.scope }
    if (pin.scope === 'workspace') void this.pubSubService.broadcastToWorkspace(pin.workspaceId, event)
    else if (pin.userId) this.pubSubService.broadcastToUser(pin.userId as UserId, event)
  }

  /** @spec NAV-REQ-3, NAV-REQ-4, NAV-NFR-2 */
  async list(workspaceId: string, userId: string): Promise<NavbarPin[]> {
    await this.assertAccess(workspaceId, userId)
    const privateWs = await this.privateWorkspaceId(userId)
    const [workspacePins, personalLocal, personalGlobal] = await Promise.all([
      this.pins.find({ workspaceId, scope: 'workspace' }).sort({ order: 1 }).toArray(),
      this.pins.find({ workspaceId, scope: 'personal', userId, global: { $ne: true } }).sort({ order: 1 }).toArray(),
      this.pins.find({ workspaceId: privateWs, scope: 'personal', userId, global: true }).sort({ order: 1 }).toArray(),
    ])
    const personal = [...personalLocal, ...personalGlobal].sort((a, b) => a.order - b.order)
    return [...workspacePins, ...personal]
  }

  private async nextOrder(filter: Record<string, unknown>): Promise<number> {
    const last = await this.pins.find(filter).sort({ order: -1 }).limit(1).toArray()
    return last.length ? last[0].order + 1 : 0
  }

  /** @spec NAV-REQ-2, NAV-REQ-5, NAV-REQ-6 */
  async pin(input: PinInput, userId: string): Promise<{ pin: NavbarPin; existed: boolean }> {
    if (!input.window?.type) throw new NavbarPinError('INVALID_WINDOW', 'window.type is required')
    const isWorkspaceLink = input.window.type === WORKSPACE_LINK
    let workspaceId = input.workspaceId
    let global = false
    if (input.scope === 'workspace') {
      if (!(await this.workspaceService.canAdmin(workspaceId, userId))) {
        throw new NavbarPinError('ACCESS_DENIED', 'Only the workspace owner or an admin can pin to the workspace zone')
      }
    } else {
      await this.assertAccess(workspaceId, userId)
      if (isWorkspaceLink) {
        // NAV-REQ-5: a link to a workspace is always global.
        workspaceId = await this.privateWorkspaceId(userId)
        global = true
      }
    }
    const key = pinKey(input.window)
    const zoneFilter: Record<string, unknown> =
      input.scope === 'workspace' ? { workspaceId, scope: 'workspace' } : { workspaceId, scope: 'personal', userId }
    const existing = await this.pins.findOne({ ...zoneFilter, key })
    if (existing) return { pin: existing, existed: true }

    const now = new Date().toISOString()
    const pin: NavbarPin = {
      pinId: `pin_${nanoid(12)}`,
      workspaceId,
      scope: input.scope,
      ...(input.scope === 'personal' ? { userId, global } : {}),
      window: { type: input.window.type, props: input.window.props ?? {} },
      key,
      ...(input.label ? { label: input.label } : {}),
      ...(input.icon ? { icon: input.icon } : {}),
      display: input.display ?? 'row',
      enabled: true,
      order: await this.nextOrder(zoneFilter),
      factory: false,
      createdBy: input.createdBy ?? { kind: 'user', id: userId },
      createdAt: now,
      updatedAt: now,
    }
    await this.pins.insertOne(pin)
    if (input.position?.before) await this.placeBefore(pin, input.position.before, zoneFilter)
    this.notify(pin)
    return { pin: (await this.pins.findOne({ pinId: pin.pinId })) ?? pin, existed: false }
  }

  private async placeBefore(pin: NavbarPin, beforeId: string, zoneFilter: Record<string, unknown>): Promise<void> {
    const zone = await this.pins.find(zoneFilter).sort({ order: 1 }).toArray()
    const ids = zone.map((p) => p.pinId).filter((id) => id !== pin.pinId)
    const idx = ids.indexOf(beforeId)
    if (idx === -1) return
    ids.splice(idx, 0, pin.pinId)
    await this.applyOrder(ids)
  }

  private async applyOrder(ids: string[]): Promise<void> {
    if (!ids.length) return
    await this.pins.bulkWrite(
      ids.map((pinId, order) => ({ updateOne: { filter: { pinId }, update: { $set: { order } } } })),
    )
  }

  private async getOrThrow(pinId: string): Promise<NavbarPin> {
    const pin = await this.pins.findOne({ pinId })
    if (!pin) throw new NavbarPinError('PIN_NOT_FOUND', 'Pin not found')
    return pin
  }

  /** @spec NAV-REQ-10 */
  async unpin(pinId: string, userId: string): Promise<NavbarPin> {
    const pin = await this.getOrThrow(pinId)
    await this.assertCanEdit(pin, userId)
    await this.pins.deleteOne({ pinId })
    this.notify(pin)
    return pin
  }

  /** @spec NAV-REQ-10 */
  async update(
    pinId: string,
    patch: { label?: string; display?: 'row' | 'widget'; enabled?: boolean },
    userId: string,
  ): Promise<NavbarPin> {
    const pin = await this.getOrThrow(pinId)
    await this.assertCanEdit(pin, userId)
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    if (typeof patch.label === 'string') set.label = patch.label.trim()
    if (patch.display) set.display = patch.display
    if (typeof patch.enabled === 'boolean') set.enabled = patch.enabled
    await this.pins.updateOne({ pinId }, { $set: set })
    const updated = (await this.pins.findOne({ pinId })) as NavbarPin
    this.notify(updated)
    return updated
  }

  /**
   * Move a pin between zones, or a personal pin between local and global.
   * `workspaceId` is the active workspace (destination for workspace scope and
   * for "make local").
   * @spec NAV-REQ-5, NAV-REQ-10
   */
  async move(
    pinId: string,
    to: { scope?: NavbarPinScope; global?: boolean; workspaceId: string },
    userId: string,
  ): Promise<NavbarPin> {
    const pin = await this.getOrThrow(pinId)
    await this.assertCanEdit(pin, userId)
    const scope = to.scope ?? pin.scope
    const isWorkspaceLink = pin.window.type === WORKSPACE_LINK
    let workspaceId = to.workspaceId
    let global = false
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    const unset: Record<string, ''> = {}
    if (scope === 'workspace') {
      if (isWorkspaceLink) throw new NavbarPinError('INVALID_WINDOW', 'A workspace link cannot be pinned to the workspace zone')
      if (!(await this.workspaceService.canAdmin(workspaceId, userId))) {
        throw new NavbarPinError('ACCESS_DENIED', 'Only the workspace owner or an admin can pin to the workspace zone')
      }
      unset.userId = ''
      unset.global = ''
    } else {
      await this.assertAccess(workspaceId, userId)
      global = isWorkspaceLink ? true : to.global ?? (pin.scope === 'personal' ? !!pin.global : false)
      if (global) workspaceId = await this.privateWorkspaceId(userId)
      set.userId = userId
      set.global = global
    }
    const zoneFilter: Record<string, unknown> =
      scope === 'workspace' ? { workspaceId, scope: 'workspace' } : { workspaceId, scope: 'personal', userId }
    const dup = await this.pins.findOne({ ...zoneFilter, key: pin.key, pinId: { $ne: pinId } })
    if (dup) {
      // Already present in the destination zone: the move collapses into a removal.
      await this.pins.deleteOne({ pinId })
      this.notify(pin)
      this.notify(dup)
      return dup
    }
    set.scope = scope
    set.workspaceId = workspaceId
    set.order = await this.nextOrder(zoneFilter)
    await this.pins.updateOne({ pinId }, Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set })
    const moved = (await this.pins.findOne({ pinId })) as NavbarPin
    this.notify(pin)
    this.notify(moved)
    return moved
  }

  /** @spec NAV-REQ-10 — full order of one zone (ids not listed keep their relative order after). */
  async reorder(workspaceId: string, scope: NavbarPinScope, pinIds: string[], userId: string): Promise<void> {
    const zoneFilter: Record<string, unknown> =
      scope === 'workspace' ? { workspaceId, scope: 'workspace' } : { workspaceId, scope: 'personal', userId }
    if (scope === 'workspace') {
      if (!(await this.workspaceService.canAdmin(workspaceId, userId))) {
        throw new NavbarPinError('ACCESS_DENIED', 'Only the workspace owner or an admin can reorder the workspace zone')
      }
    } else {
      await this.assertAccess(workspaceId, userId)
    }
    const zone = await this.pins.find(zoneFilter).sort({ order: 1 }).toArray()
    const known = new Set(zone.map((p) => p.pinId))
    const ordered = pinIds.filter((id) => known.has(id))
    const rest = zone.map((p) => p.pinId).filter((id) => !ordered.includes(id))
    await this.applyOrder([...ordered, ...rest])
    this.notify({ workspaceId, scope, userId })
  }

  /**
   * Seed the factory pins of a workspace (NAV-REQ-7). Idempotent: a workspace
   * that already has any factory pin is left untouched (the admin may have
   * removed some on purpose).
   * @returns number of pins inserted
   */
  async seedFactoryPins(workspaceId: string, ownerId: string): Promise<number> {
    const existing = await this.pins.countDocuments({ workspaceId, scope: 'workspace', factory: true })
    if (existing > 0) return 0
    const now = new Date().toISOString()
    const base = await this.nextOrder({ workspaceId, scope: 'workspace' })
    const docs: NavbarPin[] = FACTORY_PINS.map((f, i) => {
      const window = { type: f.type, props: { workspaceId } }
      return {
        pinId: `pin_${nanoid(12)}`,
        workspaceId,
        scope: 'workspace',
        window,
        key: pinKey(window),
        labelKey: f.labelKey,
        icon: f.icon,
        display: 'row',
        enabled: true,
        order: base + i,
        factory: true,
        createdBy: { kind: 'system', id: 'factory' },
        createdAt: now,
        updatedAt: now,
      }
    })
    await this.pins.insertMany(docs)
    this.notify({ workspaceId, scope: 'workspace' })
    return docs.length
  }
}
