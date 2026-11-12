import type { Db } from 'mongodb'
import type { Migration } from './types.js'

/**
 * Teros provider v2 — T-shirt sizes (TPROV-REQ-12).
 *
 * The `teros` provider stops exposing upstream model names: its only active
 * models are the sizes `teros-l` / `teros-m` / `teros-s`, and every Teros
 * provider config carries, per size, the upstream + model + effort that serve
 * it (plus a failover policy). This migration writes today's reality into
 * existing data so nothing changes until an admin edits a config from the
 * admin window:
 *
 *   1. `teros_provider_configs` — add `sizes` + `failover` (Fireworks GLM-5.3
 *      high / GLM-5.3 Flash medium / DeepSeek V4.1 Flash none; failover off)
 *      to every config lacking them.
 *   2. `models` — upsert the three sizes; mark every other `teros` model
 *      `deprecated` (the sync script only runs on deploy, so the catalogue
 *      change is applied here too).
 *   3. `user_providers` (teros) — refresh the models snapshot to the sizes.
 *   4. `user_providers.defaultModelId` / `agents.selectedModelId` — remap old
 *      teros ids to sizes (glm-5p3-flash → M, deepseek-v4p1-flash → S, the
 *      rest → L).
 *
 * Idempotent: re-running finds nothing to add, remaps nothing and leaves the
 * upserts unchanged.
 *
 * @spec TPROV-REQ-12
 */
const migration: Migration = {
  description:
    'Teros sizes (TPROV): size routes on every Teros provider config, size models in the catalogue, ' +
    'teros provider snapshots refreshed, old teros ids remapped to sizes.',

  async up(db: Db): Promise<void> {
    const { DEFAULT_TEROS_SIZE_ROUTES, DEFAULT_TEROS_SIZES, MODELS_TEROS, sizeForLegacyModelId, sizeOfModelId, TEROS_SIZE_MODEL_ID } =
      await import('../models/providers/teros.js')
    const nowIso = new Date().toISOString()
    const now = new Date()

    // ── 1. Size routes on every config ─────────────────────────────────────
    const configs = db.collection('teros_provider_configs')
    const r1 = await configs.updateMany(
      { $or: [{ sizes: { $exists: false } }, { failover: { $exists: false } }] },
      // The single-route shape of TPROV-REQ-4; 20261109_001 splits it into lanes (TLANE-REQ-6).
      { $set: { sizes: DEFAULT_TEROS_SIZE_ROUTES, failover: DEFAULT_TEROS_SIZES.failover, updatedAt: now } },
    )
    console.log(`[Migration] teros_provider_configs: size routes added to ${r1.modifiedCount} config(s)`)

    // ── 2. The models catalogue: sizes in, everything else teros deprecated ─
    const models = db.collection('models')
    const sizes = MODELS_TEROS.filter((m) => m.status === 'active')
    for (const def of sizes) {
      const existing = await models.findOne({ modelId: def.modelId })
      await models.updateOne(
        { modelId: def.modelId },
        { $set: { ...def, updatedAt: nowIso, createdAt: existing?.createdAt ?? nowIso } },
        { upsert: true },
      )
    }
    const sizeIds = sizes.map((m) => m.modelId)
    const r2 = await models.updateMany(
      { provider: 'teros', modelId: { $nin: sizeIds }, status: { $ne: 'deprecated' } },
      { $set: { status: 'deprecated', updatedAt: nowIso } },
    )
    console.log(`[Migration] models: ${sizeIds.length} size(s) upserted, ${r2.modifiedCount} legacy teros model(s) deprecated`)

    // ── 3. Teros provider snapshots → the sizes ─────────────────────────────
    const userProviders = db.collection('user_providers')
    const snapshot = sizes.map((m) => ({
      modelId: m.modelId,
      name: m.name,
      modelString: m.modelString,
      capabilities: {
        streaming: m.capabilities.streaming,
        tools: m.capabilities.tools,
        vision: m.capabilities.vision,
        thinking: m.capabilities.thinking,
        reasoningLevel: m.capabilities.thinking ? 2 : 1,
      },
      context: { maxTokens: m.context.maxTokens, maxOutputTokens: m.context.maxOutputTokens },
    }))
    const r3 = await userProviders.updateMany(
      { providerType: 'teros', 'models.modelId': { $nin: sizeIds } },
      { $set: { models: snapshot, updatedAt: nowIso } },
    )
    const r3b = await userProviders.updateMany(
      { providerType: 'teros', $or: [{ models: { $size: 0 } }, { models: { $exists: false } }] },
      { $set: { models: snapshot, updatedAt: nowIso } },
    )
    console.log(`[Migration] user_providers (teros): snapshot refreshed on ${r3.modifiedCount + r3b.modifiedCount} provider(s)`)

    // ── 4. Old ids → sizes ──────────────────────────────────────────────────
    const agents = db.collection('agents')
    const legacyIds = MODELS_TEROS.map((m) => m.modelId).filter((id) => !sizeOfModelId(id))
    let defaults = 0
    let pins = 0
    for (const legacy of legacyIds) {
      const size = sizeForLegacyModelId(legacy)
      const target = TEROS_SIZE_MODEL_ID[size]
      const p = await userProviders.updateMany(
        { providerType: 'teros', defaultModelId: legacy },
        { $set: { defaultModelId: target, updatedAt: nowIso } },
      )
      defaults += p.modifiedCount
      const a = await agents.updateMany({ selectedModelId: legacy }, { $set: { selectedModelId: target, updatedAt: nowIso } })
      pins += a.modifiedCount
    }
    // A teros provider with no default at all gets L.
    const p0 = await userProviders.updateMany(
      { providerType: 'teros', $or: [{ defaultModelId: { $exists: false } }, { defaultModelId: null }] },
      { $set: { defaultModelId: TEROS_SIZE_MODEL_ID.l, updatedAt: nowIso } },
    )
    console.log(
      `[Migration] remapped ${defaults + p0.modifiedCount} provider default(s) and ${pins} agent pin(s) to sizes`,
    )
  },

  async down(_db: Db): Promise<void> {
    // Snapshots and remaps cannot be restored from here (the catalogue moved
    // on); the size routes are harmless to keep. No-op by design.
    console.log('[Migration] 20261103_001_teros_sizes: down is a no-op')
  },
}

export default migration
