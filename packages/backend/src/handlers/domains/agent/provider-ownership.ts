/**
 * An agent may only be wired to providers its owner owns (MOD-8).
 *
 * agent.set-providers / agent.update / agent.set-preferred-provider stored
 * whatever providerIds they were given, so an agent could be pointed at
 * another user's provider — and run on that user's API key. The literal
 * 'teros' is a legacy keyword, not a provider id.
 */

import type { Db } from "mongodb"
import { HandlerError } from "../../../ws-framework/WsRouter"

export async function assertOwnProviders(
  db: Db,
  userId: string,
  providerIds: Array<string | null | undefined>,
): Promise<void> {
  const ids = [
    ...new Set(
      providerIds.filter(
        (id): id is string => typeof id === "string" && id !== "" && id !== "teros",
      ),
    ),
  ]
  if (ids.length === 0) return
  const owned = await db
    .collection("user_providers")
    .find({ providerId: { $in: ids }, userId }, { projection: { providerId: 1 } })
    .toArray()
  const ownedIds = new Set(owned.map((p) => p.providerId as string))
  const foreign = ids.filter((id) => !ownedIds.has(id))
  if (foreign.length > 0) {
    throw new HandlerError("PROVIDER_NOT_FOUND", `Provider(s) not found: ${foreign.join(", ")}`)
  }
}
