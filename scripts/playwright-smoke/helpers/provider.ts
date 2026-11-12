/**
 * Idempotent setup of the credential-free `teros` provider (size L) so a test
 * agent can actually respond. Reuses an existing teros provider if present.
 * Backend resolves the Fireworks system secret; no user credentials needed.
 *
 * 2026-10-21 (e106a7545) removed `agent.setProviders`/`agent.setPreferredProvider`
 * in favor of a single model pin: `agent.setModel(agentId, providerId, modelId)`
 * → `selectedProviderId` + `selectedModelId`. The old calls crashed the specs
 * with "t.agent.setProviders is not a function" once the API was deleted.
 *
 * The model id is INLINED below on purpose: page.evaluate serializes the
 * function into the browser, where Node-scope constants do not exist — a
 * const here caused "TEST_MODEL_ID is not defined" (CI run 40310824941).
 * "teros-l" is size L of the teros provider — its default (TPROV-REQ-1). Since
 * TPROV (2026-11-03, migration 20261103_001_teros_sizes) the only ACTIVE teros
 * models are the sizes teros-l / teros-m / teros-s; teros-kimi-k3 and the other
 * legacy ids are deprecated (CI run 41562797422 failed with MODEL_NOT_SERVED).
 * It MUST be an ACTIVE catalogue entry: provider.add → testProvider →
 * discoverModels persists only status:'active' models on the user_providers
 * record, and agent.setModel validates the pin against that list
 * (MODEL_NOT_SERVED otherwise — that was CI run 40383055553). Must match
 * the modelId the seed pins on the test core (core:pw-test). The replay
 * hash (LLMRecorder.hashInput) covers messages+tool names only, so the
 * modelId swap does not invalidate the recorded cassettes.
 */
import type { Page } from "@playwright/test"

export type ProviderInfo = { providerId: string; agentId: string }

export async function ensureTerosProvider(page: Page, agentId: string): Promise<ProviderInfo> {
  return page.evaluate(async (aid) => {
    // biome-ignore lint/suspicious/noExplicitAny: browser global
    const t = (window as any).teros
    // 1) Reuse or create the teros provider (displayName is required).
    //    provider.add → testProvider → discovers + persists the static MODELS_TEROS
    //    catalogue on the record (no network: getProviderInfo only).
    const list = (await t.provider.list()).providers || []
    // biome-ignore lint/suspicious/noExplicitAny: dynamic shape
    let providerId = list.find((p: any) => p.providerType === "teros")?.providerId
    if (!providerId) {
      const r = await t.provider.add({ providerType: "teros", displayName: "Teros" })
      providerId = r.provider.providerId
    }
    // 2) Pin the agent to this provider + model (idempotent — set, not append).
    await t.agent.setModel(aid, providerId, "teros-l")
    return { providerId, agentId: aid }
  }, agentId)
}
