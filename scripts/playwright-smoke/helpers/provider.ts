/**
 * Idempotent setup of the credential-free `teros` provider (Kimi K2.6) so a test
 * agent can actually respond. Reuses an existing teros provider if present.
 * Backend resolves the Fireworks system secret; no user credentials needed.
 */
import type { Page } from "@playwright/test"

export type ProviderInfo = { providerId: string; agentId: string }

export async function ensureTerosProvider(page: Page, agentId: string): Promise<ProviderInfo> {
  return page.evaluate(async (aid) => {
    // biome-ignore lint/suspicious/noExplicitAny: browser global
    const t = (window as any).teros
    // 1) Reuse or create the teros provider (displayName is required).
    const list = (await t.provider.list()).providers || []
    // biome-ignore lint/suspicious/noExplicitAny: dynamic shape
    let providerId = list.find((p: any) => p.providerType === "teros")?.providerId
    if (!providerId) {
      const r = await t.provider.add({ providerType: "teros", displayName: "Teros (Kimi K2.6)" })
      providerId = r.provider.providerId
    }
    // 2) Attach to the agent + mark preferred (both idempotent — set, not append).
    await t.agent.setProviders(aid, [providerId])
    await t.agent.setPreferredProvider(aid, providerId)
    return { providerId, agentId: aid }
  }, agentId)
}
