import type { Db } from 'mongodb'
import type { Migration } from './types.js'

/**
 * Agent model hygiene (spec 20261017_agent-model-tools, decision D1 by Pablo).
 *
 * Three one-shot repairs, all idempotent:
 *
 * 1. **Teros provider default → `teros-glm-5p3`.** The default of the shared
 *    Teros provider must be the full GLM 5.3 — never a reserved model
 *    (`teros-glm-5p3-fast`, exclusive to Alice) and never the deprecated
 *    `teros-kimi-k3`. Any teros provider whose `defaultModelId` is one of those
 *    two is remapped. (RAW was hot-fixed by Alice on 2026-10-17 via mongosh;
 *    this migration covers pre/prod and any straggler, and the code fix in
 *    `ensureDefaultTerosProvider` prevents regression.)
 *
 * 2. **Collapse `preferredProviderId` → `selectedProviderId`** (executes the
 *    long-standing @todo alice - 2026.09.23). Where only the legacy field is
 *    set, copy it to the modern field; then unset the legacy field everywhere.
 *    Reads keep a temporary fallback until this has run in every environment.
 *
 * 3. **Clean orphan pins.** For every agent:
 *      - `availableProviders` entries pointing at nonexistent providers are removed;
 *      - a `selectedProviderId` pointing at a provider that no longer exists (or
 *        is no longer in `availableProviders`) is cleared;
 *      - a `selectedModelId` not served by any of the agent's available providers
 *        is cleared.
 *    This repairs the 8 broken/orphaned HQ agents found on 2026-10-17
 *    (Vera/Chen/Sage/Mara with no providers; Dante/Iris/Teo/Rita pointing at a
 *    deleted provider; Iria with a ghost openrouter pin).
 */

const TEROS_DEFAULT_MODEL = 'teros-glm-5p3'
const TEROS_DEFAULT_REMAP_FROM = new Set(['teros-kimi-k3', 'teros-glm-5p3-fast'])

const migration: Migration = {
  description:
    'Agent model hygiene: default Teros provider model → teros-glm-5p3, collapse ' +
    'preferredProviderId→selectedProviderId, and clean orphan provider/model pins.',

  async up(db: Db): Promise<void> {
    const userProviders = db.collection('user_providers')
    const agents = db.collection('agents')
    const now = new Date().toISOString()

    // ── 1. Teros provider default → teros-glm-5p3 ────────────────────────────
    const remapResult = await userProviders.updateMany(
      {
        providerType: 'teros',
        defaultModelId: { $in: Array.from(TEROS_DEFAULT_REMAP_FROM) },
      },
      { $set: { defaultModelId: TEROS_DEFAULT_MODEL, updatedAt: now } },
    )
    console.log(
      `[Migration] Teros provider defaultModelId remapped to ${TEROS_DEFAULT_MODEL}: ` +
        `${remapResult.modifiedCount} provider(s)`,
    )

    // ── 2. Collapse preferredProviderId → selectedProviderId ─────────────────
    // Per-document loop (not a pipeline update) so the operation stays
    // compatible with the in-memory test fake and logs each change for audit.
    // The legacy value is copied into the modern field only when the modern
    // field is absent — an explicit modern selection is never overwritten.
    const legacyAgents = await agents
      .find({ preferredProviderId: { $exists: true } })
      .toArray()
    let copied = 0
    for (const agent of legacyAgents) {
      const legacy = (agent as { preferredProviderId?: string | null }).preferredProviderId
      const modern = (agent as { selectedProviderId?: string | null }).selectedProviderId
      const setFields: Record<string, unknown> = { updatedAt: now }
      if (legacy != null && (modern === undefined || modern === null)) {
        setFields.selectedProviderId = legacy
        copied++
      }
      await agents.updateOne(
        { agentId: (agent as unknown as { agentId: string }).agentId },
        { $set: setFields, $unset: { preferredProviderId: '' } },
      )
    }
    console.log(
      `[Migration] preferredProviderId collapsed into selectedProviderId: ` +
        `${copied} copied, ${legacyAgents.length} legacy field(s) unset`,
    )

    // ── 3. Clean orphan pins ─────────────────────────────────────────────────
    const allProviders = await userProviders
      .find({}, { projection: { providerId: 1, models: 1 } })
      .toArray()
    const providerById = new Map<string, { models?: Array<{ modelId: string }> }>()
    for (const p of allProviders) {
      providerById.set(p.providerId as string, p as { models?: Array<{ modelId: string }> })
    }

    const allAgents = await agents
      .find(
        {},
        {
          projection: {
            agentId: 1,
            availableProviders: 1,
            selectedProviderId: 1,
            selectedModelId: 1,
          },
        },
      )
      .toArray()

    let cleaned = 0
    for (const agent of allAgents) {
      const available: string[] = Array.isArray(agent.availableProviders)
        ? (agent.availableProviders as string[])
        : []
      const selectedProviderId = (agent.selectedProviderId as string | null | undefined) ?? null
      const selectedModelId = (agent.selectedModelId as string | null | undefined) ?? null

      const $set: Record<string, unknown> = {}
      let touched = false

      // (a) Drop availableProviders entries that point at dead providers.
      const liveAvailable = available.filter((id) => providerById.has(id))
      if (liveAvailable.length !== available.length) {
        $set.availableProviders = liveAvailable
        touched = true
      }

      // (b) Clear a selectedProviderId that is dead or no longer available.
      if (
        selectedProviderId &&
        (!providerById.has(selectedProviderId) || !liveAvailable.includes(selectedProviderId))
      ) {
        $set.selectedProviderId = null
        touched = true
      }

      // (c) Clear a selectedModelId not served by any live available provider.
      if (selectedModelId) {
        const served = liveAvailable.some((id) =>
          (providerById.get(id)?.models ?? []).some((m) => m.modelId === selectedModelId),
        )
        if (!served) {
          $set.selectedModelId = null
          touched = true
        }
      }

      if (touched) {
        $set.updatedAt = now
        await agents.updateOne({ agentId: agent.agentId }, { $set })
        cleaned++
        console.log(`[Migration] Cleaned orphan provider/model config on agent ${agent.agentId}`)
      }
    }

    console.log(`[Migration] Orphan-pin hygiene: ${cleaned} agent(s) cleaned of ${allAgents.length}`)
  },
}

export default migration
