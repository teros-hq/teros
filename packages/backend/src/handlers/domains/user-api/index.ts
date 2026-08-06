/**
 * user-api domain — Per-user self-service endpoints.
 *
 * Naming convention: user-api.<resource>-<operation>.
 *
 * Auth: only `ctx.userId` is required (no role check). Handlers MUST force
 * `userId = ctx.userId` in the query so a user can never see someone else's
 * data.
 *
 * Currently exposes:
 *   user-api.my-usage-tokens-per-hour   — buckets of the user's own usage
 *   user-api.my-usage-list-sessions     — paginated list of the user's sessions
 */

import type { Db } from "mongodb"
import type { WsRouter } from "../../../ws-framework/WsRouter"
import { createMyUsageListSessionsHandler, createMyUsageTokensPerHourHandler } from "./my-usage"

export function registerUserApiDomain(router: WsRouter, db: Db): void {
  router.register("user-api.my-usage-tokens-per-hour", createMyUsageTokensPerHourHandler(db))
  router.register("user-api.my-usage-list-sessions", createMyUsageListSessionsHandler(db))
}
