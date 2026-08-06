/**
 * Unit — Container Agent HTTP server.
 *
 * Real HTTP server on an ephemeral port + fake IContainerBackend injected
 * (the module's real boundary). Covers: unauthenticated /health, timing-safe
 * bearer auth, every /v1 route's arg passing and response shape, input
 * validation (unsafe container names → 400), backend errors → 500 with the
 * message (so RemoteContainerBackend can surface it), and 404s.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { Server } from 'http'
import type { ContainerInfo, IContainerBackend } from '../../src/services/container-backend'
import { createContainerAgentServer } from '../../src/services/container-agent-server'

const TOKEN = 'secret-token-0123456789abcdef'

function makeInfo(overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    name: 'mca-teros-bash',
    mcaId: 'mca.teros.bash',
    hostPort: 13111,
    containerPort: 3000,
    status: 'running',
    startedAt: new Date('2026-07-05T10:00:00Z'),
    lastUsed: new Date('2026-07-05T10:00:00Z'),
    baseUrl: 'http://localhost:13111',
    ...overrides,
  }
}

function makeBackend(overrides: Partial<IContainerBackend> = {}): IContainerBackend & {
  start: ReturnType<typeof mock>
  stop: ReturnType<typeof mock>
  isActuallyRunning: ReturnType<typeof mock>
  cleanupOrphans: ReturnType<typeof mock>
  allocatePort: ReturnType<typeof mock>
  releasePort: ReturnType<typeof mock>
} {
  return {
    start: mock(async (mcaId: string, name: string) => makeInfo({ mcaId, name })),
    stop: mock(async () => {}),
    isActuallyRunning: mock(async () => true),
    cleanupOrphans: mock(async () => {}),
    allocatePort: mock(async () => 13500),
    releasePort: mock(() => {}),
    shutdown: mock(async () => {}),
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: boundary fake for the test
  } as any
}

const servers: Server[] = []

async function startAgent(
  backend: IContainerBackend,
  extra: Partial<Parameters<typeof createContainerAgentServer>[0]> = {},
): Promise<string> {
  const server = createContainerAgentServer({
    backend,
    token: TOKEN,
    agentId: 'agent-test',
    ...extra,
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
})

function authed(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } }
}

// ===========================================================================
// Auth
// ===========================================================================

describe('auth', () => {
  it('GET /health requires no token and reports the agent id', async () => {
    const url = await startAgent(makeBackend())
    const res = await fetch(`${url}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', agentId: 'agent-test' })
  })

  it('rejects missing, malformed and wrong tokens with 401', async () => {
    const backend = makeBackend()
    const url = await startAgent(backend)

    for (const headers of [
      {},
      { authorization: 'Bearer nope' },
      { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` }, // same length, wrong value
      { authorization: TOKEN }, // no Bearer prefix
    ]) {
      const res = await fetch(`${url}/v1/status`, { headers })
      expect(res.status).toBe(401)
    }
    expect(backend.start).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Routes
// ===========================================================================

describe('/v1/start', () => {
  it('passes args through to the backend and returns ContainerInfo', async () => {
    const backend = makeBackend()
    const url = await startAgent(backend)

    const res = await fetch(
      `${url}/v1/start`,
      authed({
        method: 'POST',
        body: JSON.stringify({
          mcaId: 'mca.teros.bash',
          containerName: 'mca-teros-bash',
          callbackToken: 'cbtok',
          options: { containerMode: 'per-app', appId: 'app_1', cpus: 2 },
        }),
      }),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ name: 'mca-teros-bash', status: 'running', hostPort: 13111 })
    expect(backend.start).toHaveBeenCalledWith('mca.teros.bash', 'mca-teros-bash', 'cbtok', {
      containerMode: 'per-app',
      appId: 'app_1',
      cpus: 2,
    })
  })

  it('rejects an unsafe container name with 400 BEFORE touching the backend', async () => {
    const backend = makeBackend()
    const url = await startAgent(backend)

    const res = await fetch(
      `${url}/v1/start`,
      authed({
        method: 'POST',
        body: JSON.stringify({ mcaId: 'mca.x', containerName: 'a;rm -rf /', callbackToken: 't' }),
      }),
    )

    expect(res.status).toBe(400)
    expect(backend.start).not.toHaveBeenCalled()
  })

  it('missing fields → 400 with the field name', async () => {
    const url = await startAgent(makeBackend())
    const res = await fetch(
      `${url}/v1/start`,
      authed({ method: 'POST', body: JSON.stringify({ mcaId: 'mca.x' }) }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('containerName')
  })

  it('backend errors surface as 500 with the message (client re-throws it)', async () => {
    const backend = makeBackend({
      start: mock(async () => {
        throw new Error('MCA container limit reached (250 running)')
      }),
    })
    const url = await startAgent(backend)

    const res = await fetch(
      `${url}/v1/start`,
      authed({
        method: 'POST',
        body: JSON.stringify({ mcaId: 'mca.x', containerName: 'mca-x', callbackToken: 't' }),
      }),
    )

    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('limit reached')
  })
})

describe('other routes', () => {
  it('POST /v1/stop validates the name and delegates', async () => {
    const backend = makeBackend()
    const url = await startAgent(backend)

    const ok = await fetch(
      `${url}/v1/stop`,
      authed({ method: 'POST', body: JSON.stringify({ containerName: 'mca-x' }) }),
    )
    expect(ok.status).toBe(200)
    expect(backend.stop).toHaveBeenCalledWith('mca-x')

    const bad = await fetch(
      `${url}/v1/stop`,
      authed({ method: 'POST', body: JSON.stringify({ containerName: 'a b' }) }),
    )
    expect(bad.status).toBe(400)
  })

  it('GET /v1/running returns the backend answer; unsafe name → 400', async () => {
    const backend = makeBackend({ isActuallyRunning: mock(async () => false) })
    const url = await startAgent(backend)

    const res = await fetch(`${url}/v1/running?name=mca-x`, authed())
    expect(await res.json()).toEqual({ running: false })
    expect(backend.isActuallyRunning).toHaveBeenCalledWith('mca-x')

    const bad = await fetch(`${url}/v1/running?name=a;b`, authed())
    expect(bad.status).toBe(400)
  })

  it('allocate-port / release-port / cleanup-orphans delegate', async () => {
    const backend = makeBackend()
    const url = await startAgent(backend)

    const alloc = await fetch(`${url}/v1/allocate-port`, authed({ method: 'POST' }))
    expect(await alloc.json()).toEqual({ port: 13500 })

    const release = await fetch(
      `${url}/v1/release-port`,
      authed({ method: 'POST', body: JSON.stringify({ port: 13500 }) }),
    )
    expect(release.status).toBe(200)
    expect(backend.releasePort).toHaveBeenCalledWith(13500)

    const cleanup = await fetch(`${url}/v1/cleanup-orphans`, authed({ method: 'POST' }))
    expect(cleanup.status).toBe(200)
    expect(backend.cleanupOrphans).toHaveBeenCalledTimes(1)
  })

  it('GET /v1/status reports agent id and the injected container list', async () => {
    const url = await startAgent(makeBackend(), {
      listContainers: async () => [{ name: 'mca-a', status: 'Up 5 minutes' }],
    })

    const res = await fetch(`${url}/v1/status`, authed())
    expect(await res.json()).toEqual({
      agentId: 'agent-test',
      containers: [{ name: 'mca-a', status: 'Up 5 minutes' }],
      count: 1,
    })
  })

  it('unknown routes → 404', async () => {
    const url = await startAgent(makeBackend())
    const res = await fetch(`${url}/v1/nope`, authed())
    expect(res.status).toBe(404)
  })
})
