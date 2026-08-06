/**
 * buildHealthReport — the deep /health check.
 *
 * The bug it fixes (TER-418): the old handler returned a hardcoded 200/ok even
 * with MongoDB down, so a deploy against a dead DB passed the gate. The decisive
 * assertion here is the 503 when the ping fails — that's what makes the deploy
 * health-polling able to abort + rollback.
 *
 * Runner: bun:test (pure logic; db/sessionManager mocked at the boundary).
 */
import { describe, expect, it, jest } from 'bun:test'
import { buildHealthReport } from '../../../packages/backend/src/bootstrap/health'

function makeDeps(opts: { mongoOk: boolean; connections?: number; mca?: boolean }) {
  const command = jest.fn(() =>
    opts.mongoOk ? Promise.resolve({ ok: 1 }) : Promise.reject(new Error('ECONNREFUSED')),
  )
  const deps = {
    db: { command } as any,
    sessionManager: { getConnectionCount: () => opts.connections ?? 0 },
    mcaManager: (opts.mca ? {} : null) as any,
  }
  return { deps, command }
}

describe('buildHealthReport', () => {
  it('returns 200/ok and pings Mongo with the exact command when the DB responds', async () => {
    const { deps, command } = makeDeps({ mongoOk: true, connections: 3, mca: true })
    const r = await buildHealthReport(deps)

    expect(r.statusCode).toBe(200)
    expect(r.body.status).toBe('ok')
    expect(r.body.checks).toEqual({ mongodb: 'ok' })
    expect(r.body.connections).toBe(3)
    expect(r.body.mcaManager).toBe('active')
    expect(command).toHaveBeenCalledWith({ ping: 1 }) // a real ping, not a stub
    expect(typeof r.body.timestamp).toBe('string')
  })

  it('returns 503/degraded when the Mongo ping fails (the deploy-gate bug)', async () => {
    const { deps } = makeDeps({ mongoOk: false })
    const r = await buildHealthReport(deps)

    expect(r.statusCode).toBe(503)
    expect(r.body.status).toBe('degraded')
    expect(r.body.checks).toEqual({ mongodb: 'down' })
  })

  it('never throws even when the ping rejects', async () => {
    const { deps } = makeDeps({ mongoOk: false })
    await expect(buildHealthReport(deps)).resolves.toMatchObject({ statusCode: 503 })
  })

  it('reports mcaManager "disabled" when there is no manager', async () => {
    const { deps } = makeDeps({ mongoOk: true, mca: false })
    const r = await buildHealthReport(deps)
    expect(r.body.mcaManager).toBe('disabled')
  })
})
