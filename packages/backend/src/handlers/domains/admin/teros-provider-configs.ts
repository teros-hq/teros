/**
 * admin.list-teros-provider-configs
 * admin.create-teros-provider-config
 * admin.update-teros-provider-config
 * admin.delete-teros-provider-config
 *
 * CRUD for TerosProviderConfig documents: the per-user-assignable routing of
 * the `teros` provider — sizes (L/M/S → upstream, model, effort) and failover
 * (TPROV-REQ-4, TPROV-REQ-11). Admin/super only. The legacy Fireworks key is
 * kept for the admin "test connection" flow; routing uses system secrets.
 *
 * @spec TPROV-REQ-11, TLANE-REQ-11
 */
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'
import {
  getTerosProviderConfigsCollection,
  getBillingSubscriptionsCollection,
  type TerosProviderConfig,
} from '../../../models/billing.js'
import { DEFAULT_TEROS_SIZES, validateTerosSizesConfig } from '../../../models/providers/teros.js'
import { encrypt } from '../../../auth/encryption'
import { secrets } from '../../../secrets/secrets-manager'

/** Encrypt a string using the system encryption key, returning a combined hex string. */
function encryptWithSystemKey(plaintext: string): string {
  const encryptionSecret = secrets.requireSystem('encryption')
  const systemKey = Buffer.from(encryptionSecret.masterKey, 'hex')
  const encrypted = encrypt(plaintext, systemKey)
  return encrypted.data + ':' + encrypted.iv + ':' + encrypted.tag
}

async function assertAdmin(userService: UserService, userId: string) {
  const caller = await userService.getByUserId(userId)
  if (caller?.role !== 'admin' && caller?.role !== 'super') {
    throw new HandlerError('FORBIDDEN', 'Admin privileges required')
  }
}

/** The wire shape: never the encrypted key (TPROV-REQ-11). */
function toWire(c: TerosProviderConfig) {
  return {
    _id: c._id,
    name: c.name,
    isDefault: c.isDefault,
    hasFireworksKey: !!c.fireworksApiKey,
    sizes: c.sizes ?? DEFAULT_TEROS_SIZES.sizes,
    failover: c.failover ?? DEFAULT_TEROS_SIZES.failover,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------

export function createListTerosProviderConfigsHandler(userService: UserService, db: Db) {
  return async function listTerosProviderConfigs(ctx: WsHandlerContext, _rawData: unknown) {
    await assertAdmin(userService, ctx.userId)
    const col = getTerosProviderConfigsCollection(db)
    const configs = await col.find({}).sort({ isDefault: -1, name: 1 }).toArray()
    return { configs: configs.map(toWire) }
  }
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

interface CreateConfigData {
  name: string
  /** Legacy Fireworks key for the admin test flow; optional since TPROV. */
  fireworksApiKey?: string
  isDefault?: boolean
  sizes?: unknown
  failover?: unknown
}

export function createCreateTerosProviderConfigHandler(userService: UserService, db: Db) {
  return async function createTerosProviderConfig(ctx: WsHandlerContext, rawData: unknown) {
    await assertAdmin(userService, ctx.userId)
    const data = rawData as CreateConfigData
    if (!data.name) {
      throw new HandlerError('MISSING_FIELDS', 'name is required')
    }
    const routing =
      data.sizes || data.failover
        ? validateTerosSizesConfig({ sizes: data.sizes, failover: data.failover })
        : ({ ok: true, value: DEFAULT_TEROS_SIZES } as const)
    if (!routing.ok) throw new HandlerError('INVALID_ROUTE', `Invalid route: ${routing.error}`)

    const col = getTerosProviderConfigsCollection(db)
    const now = new Date()
    const _id = `cfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    // Only the seed can create the "Default" config with isDefault=true.
    const doc: TerosProviderConfig = {
      _id,
      name: data.name,
      fireworksApiKey: data.fireworksApiKey ? encryptWithSystemKey(data.fireworksApiKey) : '',
      isDefault: false,
      sizes: routing.value.sizes,
      failover: routing.value.failover,
      createdAt: now,
      updatedAt: now,
    }
    await col.insertOne(doc)
    return { config: toWire(doc) }
  }
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

interface UpdateConfigData {
  configId: string
  name?: string
  fireworksApiKey?: string
  isDefault?: boolean
  sizes?: unknown
  failover?: unknown
}

export function createUpdateTerosProviderConfigHandler(userService: UserService, db: Db) {
  return async function updateTerosProviderConfig(ctx: WsHandlerContext, rawData: unknown) {
    await assertAdmin(userService, ctx.userId)
    const data = rawData as UpdateConfigData
    if (!data.configId) {
      throw new HandlerError('MISSING_FIELDS', 'configId is required')
    }
    const col = getTerosProviderConfigsCollection(db)
    const existing = await col.findOne({ _id: data.configId })
    if (!existing) {
      throw new HandlerError('NOT_FOUND', `Config ${data.configId} not found`)
    }
    const $set: Record<string, any> = { updatedAt: new Date() }
    if (data.name !== undefined) $set.name = data.name
    if (data.fireworksApiKey !== undefined) $set.fireworksApiKey = encryptWithSystemKey(data.fireworksApiKey)
    // isDefault can only be changed by the system seed, never via admin API
    if (data.isDefault !== undefined) {
      throw new HandlerError('FORBIDDEN', 'Cannot change isDefault via admin API. Only the system seed manages the default config.')
    }
    if (data.sizes !== undefined || data.failover !== undefined) {
      // A partial edit merges over the stored routing so every size stays valid.
      const routing = validateTerosSizesConfig({
        sizes: data.sizes ?? existing.sizes ?? DEFAULT_TEROS_SIZES.sizes,
        failover: data.failover ?? existing.failover ?? DEFAULT_TEROS_SIZES.failover,
      })
      if (!routing.ok) throw new HandlerError('INVALID_ROUTE', `Invalid route: ${routing.error}`)
      $set.sizes = routing.value.sizes
      $set.failover = routing.value.failover
    }
    await col.updateOne({ _id: data.configId }, { $set })
    const updated = await col.findOne({ _id: data.configId })
    return { config: toWire(updated!) }
  }
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

interface DeleteConfigData {
  configId: string
}

export function createDeleteTerosProviderConfigHandler(userService: UserService, db: Db) {
  return async function deleteTerosProviderConfig(ctx: WsHandlerContext, rawData: unknown) {
    await assertAdmin(userService, ctx.userId)
    const data = rawData as DeleteConfigData
    if (!data.configId) {
      throw new HandlerError('MISSING_FIELDS', 'configId is required')
    }
    const col = getTerosProviderConfigsCollection(db)
    const existing = await col.findOne({ _id: data.configId })
    if (!existing) {
      throw new HandlerError('NOT_FOUND', `Config ${data.configId} not found`)
    }
    if (existing.isDefault) {
      throw new HandlerError('FORBIDDEN', 'The default config cannot be deleted')
    }
    // Cannot delete if referenced by any subscription
    const subsCol = getBillingSubscriptionsCollection(db)
    const refCount = await subsCol.countDocuments({ terosProviderConfigId: data.configId })
    if (refCount > 0) {
      throw new HandlerError(
        'REFERENCED',
        `Config ${data.configId} is assigned to ${refCount} subscription(s) — reassign them first`,
      )
    }
    await col.deleteOne({ _id: data.configId })
    return { deleted: true, configId: data.configId }
  }
}
