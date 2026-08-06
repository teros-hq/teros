/**
 * Deep /health report — TER-418 #218.
 *
 * Bug: the old handler returned a hardcoded `{ status: 'ok' }` 200 regardless of
 * dependency health, so a deploy against an unreachable MongoDB passed the gate
 * silently. `buildHealthReport` now probes Mongo (`db.command({ping:1})`) and
 * returns 503/degraded/mongodb:down when it fails.
 *
 * This is the DETERMINISTIC layer of #218: the 503 contract that the deploy
 * tooling (wait-for-health.mjs, deploy-server.sh) consumes. The 200/ok happy path
 * against a LIVE backend is covered e2e by `scripts/playwright-smoke/tests/health.spec.ts`.
 * The full "Mongo physically down" e2e is intentionally NOT a browser spec: with
 * `docker pause` the driver hangs ~30s (no clean 503) and `docker stop` disrupts a
 * Mongo shared across worktrees — the contract it would assert is exactly this unit.
 *
 * The mock is faithful to the boundary: a down Mongo makes `db.command` REJECT
 * (MongoServerSelectionError / network error), and buildHealthReport try/catches
 * any throw into `mongodb: 'down'`.
 */
import { describe, expect, it, mock } from 'bun:test'
import { buildHealthReport, type HealthDeps } from '../../src/bootstrap/health'

function makeDeps(over: Partial<HealthDeps> = {}): HealthDeps {
  return {
    db: { command: mock(async () => ({ ok: 1 })) },
    sessionManager: { getConnectionCount: () => 0 },
    // biome-ignore lint/suspicious/noExplicitAny: McaManager not needed beyond truthiness
    mcaManager: {} as any,
    ...over,
  }
}

describe('buildHealthReport — /health profundo (TER-418 #218)', () => {
  it('Mongo vivo → 200 / ok / checks.mongodb=ok (payload exacto)', async () => {
    const r = await buildHealthReport(makeDeps())
    expect(r.statusCode).toBe(200)
    expect(r.body.status).toBe('ok')
    expect(r.body.checks).toEqual({ mongodb: 'ok' })
  })

  it('Mongo caído (ping REJECTS) → 503 / degraded / checks.mongodb=down', async () => {
    const r = await buildHealthReport(
      makeDeps({
        db: {
          command: mock(async () => {
            throw new Error('MongoServerSelectionError: connection refused')
          }),
        },
      }),
    )
    // El contrato que el deploy-gate consume: 503 ⇒ abortar + rollback (no 200 silencioso).
    expect(r.statusCode).toBe(503)
    expect(r.body.status).toBe('degraded')
    expect(r.body.checks).toEqual({ mongodb: 'down' })
  })

  it('prueba la vivacidad con un ping real (db.command({ping:1})), no asume', async () => {
    const command = mock(async () => ({ ok: 1 }))
    await buildHealthReport(makeDeps({ db: { command } }))
    expect(command).toHaveBeenCalledTimes(1)
    expect(command.mock.calls[0]?.[0]).toEqual({ ping: 1 })
  })

  it('nunca lanza aunque el ping reviente — devuelve 503, no propaga', async () => {
    const deps = makeDeps({
      db: {
        command: mock(async () => {
          throw new Error('boom')
        }),
      },
    })
    expect(buildHealthReport(deps)).resolves.toMatchObject({ statusCode: 503 })
  })

  it('refleja connections del sessionManager y mcaManager activo/deshabilitado', async () => {
    const active = await buildHealthReport(makeDeps({ sessionManager: { getConnectionCount: () => 7 } }))
    expect(active.body.connections).toBe(7)
    expect(active.body.mcaManager).toBe('active')

    const disabled = await buildHealthReport(makeDeps({ mcaManager: null }))
    expect(disabled.body.mcaManager).toBe('disabled')
  })

  it('timestamp es ISO-8601 parseable', async () => {
    const r = await buildHealthReport(makeDeps())
    expect(Number.isNaN(Date.parse(r.body.timestamp))).toBe(false)
  })
})
