/**
 * Who is who on a terminal's seat: people from the users collection (display
 * name, avatar as the app shows them), agents from the Teros agent record
 * behind an MCA bridge call (name, avatar — the instance's or its core's).
 *
 * The bridge (admin_request) carries no agent: mca.teros.terminal sends the
 * agentId of the tool call it serves, and it is trusted only when that agent
 * has been granted the calling app (agent_app_access) — the same check the
 * MCA connection manager applies to its hints. Without a usable hint, the
 * app's only grant is the agent; failing that, `agent:<appId>` with a generic
 * name. Cached briefly: these are looked up on every write.
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import { COLLECTIONS, collection } from "../../db"
import { buildAvatarUrl } from "../../lib/avatar-url"
import type { CrewIdentity } from "./driver-lease"

const CACHE_MS = 60_000

interface Cached {
  at: number
  value: Promise<CrewIdentity>
}

export class CrewIdentities {
  private cache = new Map<string, Cached>()

  constructor(private readonly db: Db) {}

  /** A person, by userId. */
  human(userId: string): Promise<CrewIdentity> {
    const fallback: CrewIdentity = { kind: "human", id: userId, name: userId, avatarUrl: null }
    return this.cached(`u:${userId}`, fallback, async () => {
      const user = await collection(this.db, COLLECTIONS.users).findOne(
        { userId },
        { projection: { profile: 1, displayName: 1, name: 1, email: 1 } },
      )
      return {
        kind: "human",
        id: userId,
        name: String(
          user?.profile?.displayName ?? user?.displayName ?? user?.name ?? user?.email ?? userId,
        ),
        avatarUrl: (user?.profile?.avatarUrl as string | undefined) ?? null,
      }
    })
  }

  /** The agent behind a bridge call (see the file header). */
  agent(ctx: WsHandlerContext, hint: unknown): Promise<CrewIdentity> {
    const appId =
      ctx.actor?.appId ?? (ctx.sessionId.startsWith("mca:") ? ctx.sessionId.slice(4) : "")
    const fromActor = ctx.actor?.agentId
    const hinted = typeof hint === "string" && hint.length <= 128 ? hint : ""
    const generic: CrewIdentity = {
      kind: "agent",
      id: `agent:${appId || "domain"}`,
      name: "Agent",
      avatarUrl: null,
    }
    return this.cached(`a:${appId}:${fromActor ?? ""}:${hinted}`, generic, async () => {
      const agentId = fromActor ?? (await this.grantedAgent(appId, hinted))
      if (!agentId) return generic
      const agent = await collection(this.db, COLLECTIONS.agents).findOne(
        { agentId },
        { projection: { name: 1, fullName: 1, avatarUrl: 1, coreId: 1 } },
      )
      let avatar = agent?.avatarUrl as string | undefined
      if (!avatar && agent?.coreId) {
        const core = await collection(this.db, COLLECTIONS.agentCores).findOne(
          { coreId: agent.coreId },
          { projection: { avatarUrl: 1 } },
        )
        avatar = core?.avatarUrl as string | undefined
      }
      return {
        kind: "agent",
        id: agentId,
        name: String(agent?.name ?? agent?.fullName ?? "Agent"),
        avatarUrl: buildAvatarUrl(avatar) ?? null,
      }
    })
  }

  private async grantedAgent(appId: string, hint: string): Promise<string | null> {
    if (!appId) return null
    const grants = await collection(this.db, COLLECTIONS.agentAppAccess)
      .find({ appId }, { projection: { agentId: 1 } })
      .limit(50)
      .toArray()
    if (hint && grants.some((g) => g.agentId === hint)) return hint
    return grants.length === 1 ? String(grants[0].agentId) : null
  }

  /** A lookup that fails never blocks a write: the fallback stands in (and is not kept). */
  private cached(
    key: string,
    fallback: CrewIdentity,
    load: () => Promise<CrewIdentity>,
  ): Promise<CrewIdentity> {
    const now = Date.now()
    const hit = this.cache.get(key)
    if (hit && now - hit.at < CACHE_MS) return hit.value
    if (this.cache.size > 500) this.cache.clear()
    const value = load().catch((err) => {
      this.cache.delete(key)
      console.warn(`[terminal] could not resolve ${key}: ${String(err)}`)
      return fallback
    })
    this.cache.set(key, { at: now, value })
    return value
  }
}
