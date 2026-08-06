/**
 * Deep health check.
 *
 * The previous /health handler returned a hardcoded `{ status: 'ok' }` with HTTP
 * 200 regardless of whether its dependencies were alive — so a deploy against an
 * unreachable MongoDB passed the gate silently (verified, TER-418). This builds
 * the report by actually probing the critical dependency, so a broken deploy
 * surfaces as 503 and the deploy's health-polling (TER-519) can abort + rollback.
 *
 * MongoDB is treated as critical (without it the backend serves nothing). Qdrant
 * (vector memory) is degraded-not-critical and will be added once a client is
 * threaded into the HTTP handler; for now it is intentionally out of scope.
 */
import type { Db } from 'mongodb'
import type { McaManager } from '../services/mca-manager'
import type { SessionManager } from '../services/session-manager'

export type CheckStatus = 'ok' | 'down'

export interface HealthReport {
  statusCode: 200 | 503
  body: {
    status: 'ok' | 'degraded'
    checks: { mongodb: CheckStatus }
    timestamp: string
    connections: number
    mcaManager: 'active' | 'disabled'
  }
}

export interface HealthDeps {
  db: Pick<Db, 'command'>
  sessionManager: Pick<SessionManager, 'getConnectionCount'>
  mcaManager: McaManager | null
}

/** Build the /health report by probing critical dependencies. Never throws. */
export async function buildHealthReport(deps: HealthDeps): Promise<HealthReport> {
  const checks: { mongodb: CheckStatus } = { mongodb: 'ok' }
  let healthy = true

  // MongoDB is critical: if it's unreachable the backend can't serve anything,
  // so the deploy gate must see a 503 rather than a hardcoded 200.
  try {
    await deps.db.command({ ping: 1 })
  } catch {
    checks.mongodb = 'down'
    healthy = false
  }

  return {
    statusCode: healthy ? 200 : 503,
    body: {
      status: healthy ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
      connections: deps.sessionManager.getConnectionCount(),
      mcaManager: deps.mcaManager ? 'active' : 'disabled',
    },
  }
}
