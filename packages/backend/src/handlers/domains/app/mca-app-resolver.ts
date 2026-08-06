/**
 * resolveMcaApp — shared, deterministic mcaId → appId resolution (Phase 7, SC1).
 *
 * The only genuinely new logic in Phase 7: it composes the existing
 * `listAppsByOwner` primitive into the D-02/D-03/D-04 search-and-tie-break rule so
 * that both handlers — `app.test-mca-tool` and the `app.get-mca-resolvability`
 * read — resolve identically and report "not installed" with the SAME wire shape
 * (D-06 requires the resolvability read and the execute call to agree on runnability).
 *
 * D-02 scope (REVISED by the 07-03 spike):
 *   The 07-03 spike discovered that in the real dev DB EVERY installed app is
 *   `ownerType: "workspace"` (its ownerId is a `work_*` id). ZERO apps are owned by
 *   the admin user directly, and ZERO are `ownerId: "system"`. The admin instead OWNS
 *   the workspaces the apps live in (e.g. admin `user_…` owns workspace `work_…`
 *   which has `mca.teros.memory` installed). The original "admin's own user + system"
 *   scope therefore resolved NOTHING, so D-02 is revised to be WORKSPACE-SCOPED:
 *   resolution searches the apps in the workspaces the calling admin owns/belongs to.
 *
 * Contract:
 *   - D-02 (revised): the search scope is, in deterministic first-match-wins order:
 *       (a) the admin's OWN user apps — `listAppsByOwner(userId)` (forward-compat;
 *           usually empty in the dev DB, but kept so a directly-user-owned app still
 *           resolves and is preferred), THEN
 *       (b) the apps of each workspace the admin owns/belongs to, obtained from
 *           `workspaceService.listUserWorkspaces(userId)` and queried per workspace
 *           via `listAppsByOwner(workspaceId, "workspace")`. Workspaces are iterated
 *           sorted by `workspaceId` (listUserWorkspaces is unsorted — D-04); the FIRST
 *           workspace with a matching mcaId wins. Only the admin's OWN workspaces are
 *           ever queried — never an arbitrary workspace id (no cross-tenant
 *           credential/ownership bleed).
 *       (c) system apps — `listAppsByOwner("system")` — as the final fallback.
 *     If `workspaceService` is null/undefined the workspace tier is skipped (own + system
 *     only) so the resolver degrades gracefully where a WorkspaceService is not wired.
 *   - D-03: own preferred over workspace preferred over system — the first tier with a
 *     match wins; within the workspace tier, earlier workspaces win.
 *   - D-04: return exactly one deterministic app.
 *   - D-01: no active app in any tier → the typed not-installed variant. This function
 *     NEVER throws for the not-installed case — callers pick their own error surface
 *     (execute throws NOT_INSTALLED; the resolvability read returns
 *     { runnable: false, reason: "not-installed" }).
 *
 * `listAppsByOwner` already filters `status: "active"` — do not re-filter here.
 */

import { NOT_INSTALLED_REASON } from "@teros/shared"
import type { McaService } from "../../../services/mca-service"
import type { WorkspaceService } from "../../../services/workspace-service"
import type { App } from "../../../types/database"

/**
 * Shared not-installed reason constant — the single source of truth lives in `@teros/shared`
 * (mca-health.ts) so the backend resolver and the frontend health dashboard use the byte-identical
 * wire value (D-06). Re-exported here so the Phase 7 handlers keep their local import path.
 */
export { NOT_INSTALLED_REASON }

/** Resolved variant: exactly one active App was found (own → workspace → system). */
export interface ResolvedMcaApp {
  resolved: true
  app: App
}

/** Not-installed variant: no active app for the mcaId in any tier of the admin's scope. */
export interface NotInstalledMcaApp {
  resolved: false
  reason: typeof NOT_INSTALLED_REASON
}

export type McaAppResolution = ResolvedMcaApp | NotInstalledMcaApp

/**
 * D-04 deterministic tie-break. `listAppsByOwner` runs an unsorted
 * `find(...).toArray()`, so if a single tier holds >1 active app with the same
 * mcaId (e.g. two installs under different names) `.find` would return whichever
 * doc Mongo enumerated first — unstable across queries. Since the resolvability
 * read and the execute call each issue their OWN resolveMcaApp (separate
 * queries), that non-determinism could make them disagree on which app runs.
 * Pick the smallest `appId` so every query resolves to the same app.
 *
 * `ownOnly` additionally excludes workspace-typed apps from the own-user tier:
 * `listAppsByOwner(userId)` passes no ownerType, so an app whose ownerId happens
 * to equal the userId but is `ownerType: "workspace"` would otherwise match tier
 * (a) and preempt the intended workspace/system precedence.
 */
function pickDeterministicMatch(apps: App[], mcaId: string, ownOnly = false): App | undefined {
  const matches = apps.filter(
    (a) => a.mcaId === mcaId && (!ownOnly || a.ownerType !== "workspace"),
  )
  if (matches.length === 0) return undefined
  return matches.reduce((best, a) => (a.appId < best.appId ? a : best))
}

/**
 * Resolve a catalog `mcaId` to exactly one installed app for the calling admin.
 *
 * @param mcaService - service exposing listAppsByOwner (status:"active" pre-filtered)
 * @param workspaceService - service exposing listUserWorkspaces (the admin's own
 *   workspaces); may be null to skip the workspace tier (own + system only)
 * @param userId - the calling admin's user id (own-apps + workspace-scope anchor)
 * @param mcaId - the catalog mca id to resolve
 * @returns a discriminated result — resolved (with the chosen App) or not-installed
 */
export async function resolveMcaApp(
  mcaService: McaService,
  workspaceService: WorkspaceService | null,
  userId: string,
  mcaId: string,
): Promise<McaAppResolution> {
  // Tier (a): the admin's OWN user apps (forward-compat; usually empty in dev).
  const ownApps = await mcaService.listAppsByOwner(userId)
  const ownMatch = pickDeterministicMatch(ownApps, mcaId, true)
  if (ownMatch) {
    return { resolved: true, app: ownMatch }
  }

  // Tier (b): apps in the workspaces the admin owns/belongs to (revised D-02 core).
  // Only the admin's OWN workspaces are ever queried — never an arbitrary workspace id.
  if (workspaceService) {
    // D-04 across workspaces: listUserWorkspaces is an unsorted find().toArray(),
    // so "first workspace with a match" was unstable across queries — the
    // resolvability read and the execute call (each issuing its own resolveMcaApp)
    // could resolve the same mcaId to apps in DIFFERENT workspaces when the admin
    // has it installed in more than one. Sort by workspaceId so both calls walk
    // the tiers identically.
    const workspaces = (await workspaceService.listUserWorkspaces(userId)).sort((a, b) =>
      a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0,
    )
    for (const ws of workspaces) {
      const wsApps = await mcaService.listAppsByOwner(ws.workspaceId, "workspace")
      const wsMatch = pickDeterministicMatch(wsApps, mcaId)
      if (wsMatch) {
        // D-03/D-04: first workspace (in listUserWorkspaces order) with a match wins.
        return { resolved: true, app: wsMatch }
      }
    }
  }

  // Tier (c): system apps as the final fallback.
  const systemApps = await mcaService.listAppsByOwner("system")
  const systemMatch = pickDeterministicMatch(systemApps, mcaId)
  if (systemMatch) {
    return { resolved: true, app: systemMatch }
  }

  // D-01: require pre-install — no auto-provision. Typed not-installed (no throw).
  return { resolved: false, reason: NOT_INSTALLED_REASON }
}
