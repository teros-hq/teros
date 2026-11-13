import type { ProviderService } from "../provider-service"

type Providers = Pick<ProviderService, "listUserProviders" | "getProviderSecrets">

const MINIMAX_ANTHROPIC_URL = "https://api.minimax.io/anthropic"
const ANTHROPIC_COMPATIBLE = ["anthropic", "minimax"]

export async function agentProviderEnv(
  providers: Providers | null | undefined,
  ownerId: string,
): Promise<Record<string, string> | null> {
  if (!providers || !ownerId) return null
  const list = await providers.listUserProviders(ownerId)
  for (const type of ANTHROPIC_COMPATIBLE) {
    const provider = list.find(
      (p) => p.providerType === type && (p.status ?? "active") === "active",
    )
    if (!provider) continue
    const secrets = await providers.getProviderSecrets(ownerId, provider.providerId)
    if (!secrets?.apiKey) continue
    return type === "minimax"
      ? { ANTHROPIC_BASE_URL: MINIMAX_ANTHROPIC_URL, ANTHROPIC_AUTH_TOKEN: secrets.apiKey }
      : { ANTHROPIC_API_KEY: secrets.apiKey }
  }
  return null
}
