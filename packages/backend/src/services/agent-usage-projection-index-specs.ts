/**
 * Index specs for the rebuildable agent-usage PROJECTION collections
 * (A1.3 / TER-675).
 *
 * The shadow rebuild (`rebuild-agent-usage-projections.ts --shadow`) builds into
 * `*_v2` collections created with only the default `_id` index, then atomically
 * renames them over the live names. Without recreating the indexes the live
 * collections lose their unique keys (idempotency broken forward) and TTLs (docs
 * never expire) after a shadow rebuild.
 *
 * These specs are the SYMMETRIC SOURCE for that recreation. They mirror exactly
 * the three projection collections the rebuild touches, as defined in the
 * `20260519_001_agent_usage` migration (the sibling source of truth for a FRESH
 * install). Keep the two in sync: if a projection index changes in the migration,
 * change it here too — the `.test.ts` pins the critical unique/TTL invariants so
 * a silent drop fails the build.
 *
 * Only the three collections the rebuild recreates live here: sessions,
 * tool_executions, event_applications. The append-only `agent_usage_events` and
 * the rollups are NOT rebuilt by the shadow script, so their indexes stay owned
 * by the migration alone.
 */

import type { CreateIndexesOptions, Db, IndexSpecification } from "mongodb"

const TTL_180_DAYS = 60 * 60 * 24 * 180

export interface ProjectionIndexSpec {
  key: IndexSpecification
  options: CreateIndexesOptions & { name: string }
}

/** `agent_usage_sessions` — one doc per turn (the main dashboard projection). */
export const SESSIONS_INDEX_SPECS: readonly ProjectionIndexSpec[] = [
  { key: { sessionUsageId: 1 }, options: { unique: true, name: "sessionUsageId_unique" } },
  { key: { userId: 1, agentId: 1, startedAt: -1 }, options: { name: "user_agent_started" } },
  {
    key: { userId: 1, agentId: 1, provider: 1, startedAt: -1 },
    options: { name: "user_agent_provider_started" },
  },
  { key: { workspaceId: 1, startedAt: -1 }, options: { name: "workspace_started" } },
  { key: { status: 1, startedAt: 1 }, options: { name: "status_started_reconcile" } },
  { key: { channelId: 1, startedAt: -1 }, options: { name: "channel_started" } },
  { key: { parentSessionUsageId: 1 }, options: { sparse: true, name: "parent_sparse" } },
  {
    key: { triggerKind: 1, startedAt: -1 },
    options: { sparse: true, name: "triggerKind_started" },
  },
  { key: { createdAt: 1 }, options: { expireAfterSeconds: TTL_180_DAYS, name: "ttl_180d" } },
]

/** `tool_executions` — append-only, one doc per tool call. */
export const TOOL_EXECUTIONS_INDEX_SPECS: readonly ProjectionIndexSpec[] = [
  { key: { toolExecutionId: 1 }, options: { unique: true, name: "toolExecutionId_unique" } },
  {
    key: { sessionUsageId: 1, stepIndex: 1, toolCallIndex: 1 },
    options: { name: "session_step_toolcall" },
  },
  { key: { userId: 1, toolName: 1, startedAt: -1 }, options: { name: "user_tool_started" } },
  { key: { mcaId: 1, startedAt: -1 }, options: { sparse: true, name: "mca_started_sparse" } },
  { key: { status: 1, startedAt: 1 }, options: { name: "status_started_reconcile" } },
  { key: { createdAt: 1 }, options: { expireAfterSeconds: TTL_180_DAYS, name: "ttl_180d" } },
]

/** `agent_usage_event_applications` — the applier's idempotency log. */
export const EVENT_APPLICATIONS_INDEX_SPECS: readonly ProjectionIndexSpec[] = [
  { key: { eventId: 1 }, options: { unique: true, name: "eventId_unique" } },
  { key: { projectedAt: 1 }, options: { expireAfterSeconds: TTL_180_DAYS, name: "ttl_180d" } },
]

/** Collection name → its projection index specs (the rebuild's recreation set). */
export const PROJECTION_INDEX_SPECS: Readonly<Record<string, readonly ProjectionIndexSpec[]>> = {
  agent_usage_sessions: SESSIONS_INDEX_SPECS,
  tool_executions: TOOL_EXECUTIONS_INDEX_SPECS,
  agent_usage_event_applications: EVENT_APPLICATIONS_INDEX_SPECS,
}

/**
 * (Re)create the projection indexes on the live collection names. Idempotent —
 * `createIndex` is a no-op when the index already exists with the same spec, so
 * this is safe to call after a shadow rename (the fix) or as a boot-time heal.
 * Returns the total number of index specs applied.
 */
export async function ensureProjectionIndexes(db: Db): Promise<number> {
  let applied = 0
  for (const [collectionName, specs] of Object.entries(PROJECTION_INDEX_SPECS)) {
    const col = db.collection(collectionName)
    for (const spec of specs) {
      await col.createIndex(spec.key, spec.options)
      applied += 1
    }
  }
  return applied
}
