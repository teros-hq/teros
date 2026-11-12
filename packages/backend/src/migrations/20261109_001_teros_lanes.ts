import type { Db } from 'mongodb'
import type { Migration } from './types.js'

/**
 * Teros latency lanes (TLANE-REQ-6).
 *
 * Every size of every `teros_provider_configs` document goes from one route
 * (`sizes.l = { upstream, modelString, reasoningEffort }`, TPROV-REQ-4) to one
 * route per lane (`sizes.l = { interactive, background }`). Both lanes get the
 * size's current route, so routing is unchanged until an admin edits the
 * config from the admin window.
 *
 * Idempotent: a size that already has lanes is left untouched.
 * `down` keeps the interactive route as the single route.
 *
 * @spec TLANE-REQ-6
 */

const SIZES = ['l', 'm', 's'] as const

/** A TPROV-REQ-4 single route (has `upstream` at the top level). */
function isSingleRoute(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && typeof (value as { upstream?: unknown }).upstream === 'string'
}

const migration: Migration = {
  description:
    'Teros lanes (TLANE): every size of every Teros provider config gets an interactive and a background route, ' +
    'both equal to its current route.',

  async up(db: Db): Promise<void> {
    const configs = db.collection('teros_provider_configs')
    let changed = 0
    for await (const cfg of configs.find({ sizes: { $exists: true } })) {
      const sizes = (cfg.sizes ?? {}) as Record<string, unknown>
      const $set: Record<string, unknown> = {}
      for (const size of SIZES) {
        const route = sizes[size]
        if (isSingleRoute(route)) {
          $set[`sizes.${size}`] = { interactive: { ...route }, background: { ...route } }
        }
      }
      if (Object.keys($set).length === 0) continue
      $set.updatedAt = new Date()
      await configs.updateOne({ _id: cfg._id }, { $set })
      changed++
    }
    console.log(`[Migration] teros_provider_configs: lanes added to ${changed} config(s)`)
  },

  async down(db: Db): Promise<void> {
    const configs = db.collection('teros_provider_configs')
    for await (const cfg of configs.find({ sizes: { $exists: true } })) {
      const sizes = (cfg.sizes ?? {}) as Record<string, { interactive?: unknown } | undefined>
      const $set: Record<string, unknown> = {}
      for (const size of SIZES) {
        const interactive = sizes[size]?.interactive
        if (isSingleRoute(interactive)) $set[`sizes.${size}`] = interactive
      }
      if (Object.keys($set).length === 0) continue
      $set.updatedAt = new Date()
      await configs.updateOne({ _id: cfg._id }, { $set })
    }
  },
}

export default migration
