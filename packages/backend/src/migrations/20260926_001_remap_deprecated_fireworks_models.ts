import type { Db } from 'mongodb'
import type { Migration } from './types.js'

/**
 * Remap deprecated Fireworks-generation models (upstream decommissioned
 * 2026-09-25) and refresh stale model snapshots.
 *
 * Context: Fireworks retired the Kimi K2.6 / K2.7 Code (±Fast), GLM-5.2 (±Fast),
 * DeepSeek V4 Pro 0813 / V4 Flash Vision Exp and Qwen 3.7 Plus serverless
 * endpoints on 2026-09-25 (changelog "Upcoming Serverless deprecation: older
 * DeepSeek, GLM, Muse, and Kimi models"). The catalog now marks them
 * `deprecated` and adds the replacements (Kimi K3/K3 Fast, GLM-5.3 Fast,
 * DeepSeek V4.1 Flash). But three DB surfaces still point at the dead strings:
 *
 *   1. `user_providers.models` — a snapshot written when the provider was
 *      created/tested. It still lists the dead models as selectable, and the
 *      resolver (`resolveModelFromProviders`) picks `selectedModelId` from
 *      THIS snapshot — so an agent pinned to a dead model keeps failing 404
 *      even though the catalog is fixed.
 *   2. `user_providers.defaultModelId` — the fallback used when an agent has
 *      no explicit selection. 8 teros providers default to the dead
 *      `teros-kimi-k2.6` (the most-used model on the platform).
 *   3. `agents.selectedModelId` — explicit per-agent pin. 2 agents pinned to
 *      dead models (Marcus → teros-kimi-k2.6, Nua → teros-glm-5p2).
 *
 * Remap targets (Fireworks' recommended migrations, 2026-09-12 changelog):
 *   teros-kimi-k2.6 / teros-kimi-k2p7-code(±fast) → teros-kimi-k3
 *   teros-glm-5p2(±fast)                          → teros-glm-5p3
 *   teros-deepseek-v4-pro-0813                    → teros-deepseek-v4p1-flash
 *   fireworks-kimi-k2p6 / k2p7-code(±fast)        → fireworks-kimi-k3
 *   fireworks-glm-5p2(±fast)                      → fireworks-glm-5p3
 *   fireworks-deepseek-v4-pro-0813 / v4-flash-vision-exp → fireworks-deepseek-v4p1-flash
 *   fireworks-qwen3p7-plus (verified dead live: 404)     → fireworks-glm-5p3
 *
 * Conservative by design: only the exact dead modelIds are remapped; anything
 * else is left untouched. Idempotent: re-running is a no-op (the dead ids no
 * longer appear after the first run).
 */

const REMAP: Record<string, string> = {
  // teros provider
  'teros-kimi-k2.6': 'teros-kimi-k3',
  'teros-kimi-k2p7-code': 'teros-kimi-k3',
  'teros-kimi-k2p7-code-fast': 'teros-kimi-k3',
  'teros-glm-5p2': 'teros-glm-5p3',
  'teros-glm-5p2-fast': 'teros-glm-5p3',
  'teros-deepseek-v4-pro-0813': 'teros-deepseek-v4p1-flash',
  // fireworks provider
  'fireworks-kimi-k2p6': 'fireworks-kimi-k3',
  'fireworks-kimi-k2p7-code': 'fireworks-kimi-k3',
  'fireworks-kimi-k2p7-code-fast': 'fireworks-kimi-k3',
  'fireworks-glm-5p2': 'fireworks-glm-5p3',
  'fireworks-glm-5p2-fast': 'fireworks-glm-5p3',
  'fireworks-deepseek-v4-pro-0813': 'fireworks-deepseek-v4p1-flash',
  'fireworks-deepseek-v4-flash-vision-exp': 'fireworks-deepseek-v4p1-flash',
  'fireworks-qwen3p7-plus': 'fireworks-glm-5p3',
}

const migration: Migration = {
  description:
    'Remap deprecated Fireworks-generation models in user_providers/agents ' +
    '(defaults, pins, and stale model snapshots) to their live replacements.',

  async up(db: Db): Promise<void> {
    const userProviders = db.collection('user_providers')
    const agents = db.collection('agents')
    const now = new Date().toISOString()

    // ── 1. Refresh the models snapshot of every teros/fireworks provider ────
    // Rebuild from the (already-updated) static catalog so the dead entries
    // disappear from pickers and the resolver, and the new ones appear.
    const { MODELS_TEROS, MODELS_FIREWORKS } = await import('../models/providers/index.js')

    const snapshotFor = (providerType: string) => {
      const defs =
        providerType === 'teros'
          ? MODELS_TEROS
          : providerType === 'fireworks'
            ? MODELS_FIREWORKS
            : null
      if (!defs) return null
      return defs
        .filter((m) => m.status === 'active')
        .map((m) => ({
          modelId: m.modelId,
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
    }

    for (const providerType of ['teros', 'fireworks'] as const) {
      const snapshot = snapshotFor(providerType)
      if (!snapshot || snapshot.length === 0) continue
      const res = await userProviders.updateMany(
        { providerType },
        { $set: { models: snapshot, updatedAt: now } },
      )
      console.log(
        `[Migration] ${providerType}: refreshed models snapshot on ${res.modifiedCount} provider(s)`,
      )
    }

    // ── 2. Remap dead defaultModelId / selectedModelId ──────────────────────
    for (const [deadId, liveId] of Object.entries(REMAP)) {
      const p = await userProviders.updateMany(
        { defaultModelId: deadId },
        { $set: { defaultModelId: liveId, updatedAt: now } },
      )
      if (p.modifiedCount > 0)
        console.log(`[Migration] defaultModelId ${deadId} → ${liveId} on ${p.modifiedCount} provider(s)`)

      const a = await agents.updateMany(
        { selectedModelId: deadId },
        { $set: { selectedModelId: liveId, updatedAt: now } },
      )
      if (a.modifiedCount > 0)
        console.log(`[Migration] agents.selectedModelId ${deadId} → ${liveId} on ${a.modifiedCount} agent(s)`)
    }
  },

  async down(db: Db): Promise<void> {
    // Snapshots cannot be restored to their pre-migration state from here
    // (they are a cache of the catalog, which has moved on). Remapping is
    // intentionally NOT reversed: pointing back at dead upstream endpoints
    // would break every affected agent. No-op by design.
    console.log('[Migration] 20260926_001: no-op down (remap targets are live models)')
  },
}

export default migration
