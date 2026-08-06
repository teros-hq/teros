/**
 * admin.list-teros-provider-configs
 * admin.create-teros-provider-config
 * admin.update-teros-provider-config
 * admin.delete-teros-provider-config
 *
 * CRUD for TerosProviderConfig documents.
 * Admin/super only.
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
import { encrypt, decrypt } from '../../../auth/encryption'
import { secrets } from '../../../secrets/secrets-manager'

/** Encrypt a string using the system encryption key, returning a combined hex string. */
function encryptWithSystemKey(plaintext: string): string {
  const encryptionSecret = secrets.requireSystem('encryption')
  const systemKey = Buffer.from(encryptionSecret.masterKey, 'hex')
  const encrypted = encrypt(plaintext, systemKey)
  // Combine data + iv + tag into a single hex string for storage
  return (
    encrypted.data +
    ':' +
    encrypted.iv +
    ':' +
    encrypted.tag
  )
}

/** Decrypt a combined hex string using the system encryption key. */
function decryptWithSystemKey(combined: string): string {
  const [data, iv, tag] = combined.split(':')
  if (!data || !iv || !tag) {
    throw new Error('Invalid encrypted format')
  }
  const encryptionSecret = secrets.requireSystem('encryption')
  const systemKey = Buffer.from(encryptionSecret.masterKey, 'hex')
  return decrypt({ data, iv, tag }, systemKey)
}

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------

export function createListTerosProviderConfigsHandler(userService: UserService, db: Db) {
  return async function listTerosProviderConfigs(ctx: WsHandlerContext, _rawData: unknown) {
    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'admin' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const col = getTerosProviderConfigsCollection(db)
    const configs = await col.find({}).toArray()

    // Strip encrypted key from response — never send it to the frontend
    const safeConfigs = configs.map((c) => ({
      _id: c._id,
      name: c.name,
      isDefault: c.isDefault,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }))

    return { configs: safeConfigs }
  }
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

interface CreateConfigData {
  name: string
  fireworksApiKey: string
  isDefault?: boolean
}

export function createCreateTerosProviderConfigHandler(userService: UserService, db: Db) {
  return async function createTerosProviderConfig(ctx: WsHandlerContext, rawData: unknown) {
    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'admin' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const data = rawData as CreateConfigData
    if (!data.name || !data.fireworksApiKey) {
      throw new HandlerError('MISSING_FIELDS', 'name and fireworksApiKey are required')
    }

    const col = getTerosProviderConfigsCollection(db)
    const now = new Date()

    const _id = `cfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

    // Only the seed can create the "Default" config with isDefault=true.
    // User-created configs are always non-default.
    const isDefault = false

    const doc: TerosProviderConfig = {
      _id,
      name: data.name,
      fireworksApiKey: encryptWithSystemKey(data.fireworksApiKey),
      isDefault,
      createdAt: now,
      updatedAt: now,
    }

    await col.insertOne(doc)

    return {
      config: {
        _id: doc._id,
        name: doc.name,
        isDefault: doc.isDefault,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
      },
    }
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
}

export function createUpdateTerosProviderConfigHandler(userService: UserService, db: Db) {
  return async function updateTerosProviderConfig(ctx: WsHandlerContext, rawData: unknown) {
    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'admin' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

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

    await col.updateOne({ _id: data.configId }, { $set })

    const updated = await col.findOne({ _id: data.configId })

    return {
      config: {
        _id: updated!._id,
        name: updated!.name,
        isDefault: updated!.isDefault,
        createdAt: updated!.createdAt.toISOString(),
        updatedAt: updated!.updatedAt.toISOString(),
      },
    }
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
    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'admin' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const data = rawData as DeleteConfigData
    if (!data.configId) {
      throw new HandlerError('MISSING_FIELDS', 'configId is required')
    }

    const col = getTerosProviderConfigsCollection(db)
    const existing = await col.findOne({ _id: data.configId })
    if (!existing) {
      throw new HandlerError('NOT_FOUND', `Config ${data.configId} not found`)
    }

    // Cannot delete if referenced by any subscription
    const subsCol = getBillingSubscriptionsCollection(db)
    const refCount = await subsCol.countDocuments({ terosProviderConfigId: data.configId })
    if (refCount > 0) {
      throw new HandlerError(
        'REFERENCED',
        `Cannot delete config ${data.configId}: referenced by ${refCount} subscription(s)`,
      )
    }

    // Cannot delete the only remaining default
    if (existing.isDefault) {
      const defaultCount = await col.countDocuments({ isDefault: true })
      if (defaultCount <= 1) {
        throw new HandlerError('CONSTRAINT_VIOLATION', 'Cannot delete the only default config')
      }
    }

    await col.deleteOne({ _id: data.configId })

    return { deleted: true, configId: data.configId }
  }
}
