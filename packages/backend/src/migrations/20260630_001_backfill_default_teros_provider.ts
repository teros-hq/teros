import type { Db } from "mongodb"
import { ProviderService } from "../services/provider-service.js"
import type { Migration } from "./types.js"

/**
 * Backfill the default Teros provider for every user that has NO provider at all.
 *
 * Context: the simplified onboarding (PR #308) removed the provider-selection
 * step, which was the only place a user obtained a provider. New users therefore
 * ended up with zero `user_providers`, so their agent could not resolve an LLM
 * and the chat failed with "No AI provider is configured". `createUser` now
 * provisions the Teros provider on signup; this migration repairs the users that
 * signed up between that deploy and the fix.
 *
 * Conservative by design: only users with ZERO providers are touched. A user who
 * already connected a provider (e.g. BYOK) is left untouched — they can already
 * chat, and we never alter a setup they chose. Reuses
 * `ProviderService.ensureDefaultTerosProvider` so the provider shape stays in
 * lockstep with the signup path (single source of truth).
 *
 * Idempotent: re-running is a no-op (users now have a provider, so the
 * "zero providers" filter excludes them).
 */
const migration: Migration = {
  description:
    "Backfill the default Teros provider for users that have no provider at all " +
    "(repairs accounts created after the simplified-onboarding deploy).",

  async up(db: Db): Promise<void> {
    const providerService = new ProviderService(db)
    const users = db.collection<{ userId: string }>("users")
    const userProviders = db.collection("user_providers")

    // Users that already have at least one provider — never touched.
    const userIdsWithProvider = new Set((await userProviders.distinct("userId")) as string[])

    const allUsers = await users.find({}, { projection: { userId: 1, _id: 0 } }).toArray()

    const targets = allUsers.filter((u) => u.userId && !userIdsWithProvider.has(u.userId))
    console.log(
      `[Migration] ${allUsers.length} user(s) total, ${targets.length} without any provider — provisioning Teros default`,
    )

    let provisioned = 0
    let failed = 0
    for (const { userId } of targets) {
      try {
        await providerService.ensureDefaultTerosProvider(userId)
        provisioned++
      } catch (error) {
        failed++
        console.error(`[Migration] Failed to provision Teros provider for user ${userId}:`, error)
      }
    }

    console.log(
      `[Migration] Provisioned default Teros provider for ${provisioned} user(s) (${failed} failed)`,
    )
  },
}

export default migration
