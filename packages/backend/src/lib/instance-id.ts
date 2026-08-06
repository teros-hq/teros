/**
 * Instance identification for multi-instance deployments.
 *
 * Used by:
 *   - LeaderElectionService → ownerId field of `leader_locks`.
 *   - UsageEventBuffer → dead-letter filenames so concurrent instances do
 *     not stomp on each other's files on a shared volume.
 *   - /metrics endpoint → `instance` label on every Prometheus series so the
 *     scraper can aggregate or split by node.
 *
 * Resolution order:
 *   1. `process.env.INSTANCE_ID` if set. Used by orchestrators (K8s,
 *      PM2 cluster mode) that already produce a stable identifier.
 *   2. `process.env.HOSTNAME` + `process.pid` as a useful fallback inside
 *      containers / PM2 where the pid is meaningful.
 *   3. `os.hostname()` + `process.pid` otherwise.
 *   4. A random 8-byte hex if hostname resolution somehow fails.
 *
 * The id is computed once at module load and exported as a constant.
 */

import { randomBytes } from "node:crypto"
import { hostname } from "node:os"

function computeInstanceId(): string {
  const envOverride = process.env.INSTANCE_ID?.trim()
  if (envOverride) return envOverride

  const envHost = process.env.HOSTNAME?.trim()
  const host = envHost || safeHostname()
  if (host) return `${host}-${process.pid}`

  return `instance-${randomBytes(8).toString("hex")}`
}

function safeHostname(): string | null {
  try {
    return hostname()
  } catch {
    return null
  }
}

export const INSTANCE_ID = computeInstanceId()

/**
 * Sanitize an instance id for use in a filesystem path. Keeps alphanumerics,
 * dashes and underscores; replaces anything else with an underscore.
 */
export function sanitizeInstanceIdForFilename(id: string = INSTANCE_ID): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_")
}
