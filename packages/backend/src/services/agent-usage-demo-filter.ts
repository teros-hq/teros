/**
 * Structural guard against demo-seed contamination (A1.2 / A3.7).
 *
 * `scripts/demo-monitoring-seed.mts` writes `demoSeed: true` on the sessions,
 * hourly rollups and tool executions it fabricates for local design parity. That
 * script NEVER runs in production, so in prod this predicate is a no-op — it is
 * defense-in-depth so a developer with demo data loaded never sees it blended
 * into real numbers, and (the load-bearing part) so the hourly rollup job never
 * folds demo sessions into REAL rollups.
 *
 * Use `$ne: true` — NOT `{ $exists: false }` — because real documents simply
 * omit the field; only the explicit `demoSeed: true` marker must be excluded, and
 * every real doc (which lacks the field) has to pass.
 *
 * Applied at every read of a demo-pollutable collection:
 *   - the three dashboard pipeline builders (`agent-usage-query-helper.ts`),
 *   - the model-health rollup/live reads (`admin-api/agent-usage.ts`),
 *   - the hourly rollup job's session scan (`agent-usage-rollup-job.ts`).
 *
 * `agent_usage_rollups_user_hourly` and `llm_usage` are not seeded, so the
 * billing/reconciler paths that read them are intentionally left untouched.
 */
export const EXCLUDE_DEMO_SEED = { demoSeed: { $ne: true } } as const
