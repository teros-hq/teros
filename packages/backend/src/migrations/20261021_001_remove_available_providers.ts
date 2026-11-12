import type { Db } from 'mongodb'
import type { Migration } from './types.js'

/**
 * Remove the `availableProviders` concept (2026-10-21, decision by Pablo).
 *
 * The agent model is now a strict 2-level model:
 *   1. Agent pin (`selectedProviderId` + `selectedModelId`) → that exact pair.
 *   2. No pin (System Default) → the user's default provider (`isDefault: true`)
 *      and its `defaultModelId`. No silent fallback to "first provider".
 *
 * The per-agent provider list no longer exists as a concept — the runtime
 * resolver, handlers, tools and UI were refactored accordingly in the same
 * change. This migration cleans up the stored data, idempotently:
 *
 * 1. **Agents with a non-empty `availableProviders`:**
 *      - keep the pin if it points at a live provider that serves the pinned
 *        model (the pin is the only thing that matters now);
 *      - otherwise clear the pin (agent falls back to System Default, i.e. the
 *        user's default provider — exactly the behavior Pablo expected when he
 *        unpinned the HQ agents).
 * 2. **Unset `availableProviders` everywhere** — the field is dead. Legacy
 *    documents that somehow regain it are simply ignored by the new code, but
 *    we remove it so the data matches the model.
 * 3. **Clear pins pointing at dead providers or ghost models** (same hygiene
 *    as 20261017_001, but scoped to the owner's providers instead of the
 *    agent's list).
 *
 * Behavior change vs. the old cascade: an agent with a list and no pin used to
 * resolve to the default of its FIRST list provider. It now resolves to the
 * USER's default provider. Agents with `availableProviders: []` (the state of
 * every Teros HQ agent since Pablo's manual cleanup) keep their current
 * behavior.
 */

const migration: Migration = {
  description:
    'Remove the availableProviders concept: clear orphan pins against the owner providers ' +
    'and unset the dead field from every agent document.',

  async up(db: Db): Promise<void> {
    const userProviders = db.collection('user_providers')
    const agents = db.collection('agents')
    const now = new Date().toISOString()

    // Index the owner's live providers once: providerId → set of served models.
    const allProviders = await userProviders
      .find({}, { projection: { providerId: 1, models: 1 } })
      .toArray()
    const providerById = new Map<string, Set<string>>()
    for (const p of allProviders) {
      const models = ((p as { models?: Array<{ modelId: string }> }).models ?? []).map(
        (m) => m.modelId,
      )
      providerById.set(p.providerId as string, new Set(models))
    }

    const allAgents = await agents
      .find(
        {},
        {
          projection: {
            agentId: 1,
            ownerId: 1,
            availableProviders: 1,
            selectedProviderId: 1,
            selectedModelId: 1,
          },
        },
      )
      .toArray()

    let pinsKept = 0
    let pinsCleared = 0
    let fieldsUnset = 0

    for (const agent of allAgents) {
      const selectedProviderId = (agent.selectedProviderId as string | null | undefined) ?? null
      const selectedModelId = (agent.selectedModelId as string | null | undefined) ?? null
      const hasList = Array.isArray(agent.availableProviders) && (agent.availableProviders as string[]).length > 0

      const $set: Record<string, unknown> = {}
      const $unset: Record<string, unknown> = {}
      let touched = false

      // ── 1. Validate the pin against the OWNER's live providers ─────────────
      // The list no longer gates anything; the only question is whether the pin
      // itself is still valid. An invalid pin is cleared so the agent falls
      // back to System Default (the user's default provider).
      if (selectedProviderId) {
        const servedModels = providerById.get(selectedProviderId)
        if (!servedModels) {
          $set.selectedProviderId = null
          $set.selectedModelId = null
          touched = true
          pinsCleared++
          console.log(
            `[Migration] Cleared dead-provider pin on agent ${agent.agentId} ` +
              `(provider ${selectedProviderId} no longer exists)`,
          )
        } else if (selectedModelId && !servedModels.has(selectedModelId)) {
          $set.selectedModelId = null
          touched = true
          console.log(
            `[Migration] Cleared ghost model pin on agent ${agent.agentId} ` +
              `(provider ${selectedProviderId} does not serve ${selectedModelId})`,
          )
        } else {
          pinsKept++
        }
      }

      // ── 2. Unset the dead field ─────────────────────────────────────────────
      if (agent.availableProviders !== undefined) {
        $unset.availableProviders = ''
        touched = true
        fieldsUnset++
      }

      if (touched) {
        $set.updatedAt = now
        await agents.updateOne({ agentId: agent.agentId }, { $set, $unset })
      }
    }

    console.log(
      `[Migration] availableProviders removal: ${fieldsUnset} field(s) unset, ` +
        `${pinsKept} valid pin(s) kept, ${pinsCleared} dead pin(s) cleared ` +
        `across ${allAgents.length} agent(s)`,
    )
  },
}

export default migration
