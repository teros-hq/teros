/**
 * Unit — RemoteContainerBackend (HTTP client for the container agent).
 *
 * Mocked boundary: `global.fetch`. Covers: URL/method/auth-header/body
 * construction per IContainerBackend method, Date revival on start(),
 * error semantics parity with the local backend (start throws with the
 * agent message; stop/cleanupOrphans best-effort; isActuallyRunning false
 * when the agent is unreachable; releasePort fire-and-forget).
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { RemoteContainerBackend } from '../../src/services/remote-container-backend'

const realFetch = global.fetch

afterEach(() => {
  global.fetch = realFetch
})

type FetchCall = { url: string; init: RequestInit }

/** Install a fetch mock that records calls and replies from a script. */
function mockFetch(
  reply: (url: string, init: RequestInit) => { status?: number; body?: unknown } | Error,
): FetchCall[] {
  const calls: FetchCall[] = []
  global.fetch = mock(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    const r = reply(String(url), init)
    if (r instanceof Error) throw r
    return new Response(r.body !== undefined ? JSON.stringify(r.body) : '', {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return calls
}

function makeBackend(): RemoteContainerBackend {
  return new RemoteContainerBackend({
    agentUrl: 'http://127.0.0.1:10011/', // trailing slash must be normalized away
    agentToken: 'tok-abc',
  })
}

const WIRE_INFO = {
  name: 'mca-teros-bash',
  mcaId: 'mca.teros.bash',
  hostPort: 13111,
  containerPort: 3000,
  status: 'running',
  startedAt: '2026-07-05T10:00:00.000Z',
  lastUsed: '2026-07-05T10:00:01.000Z',
  baseUrl: 'http://localhost:13111',
}

describe('start', () => {
  it('POSTs /v1/start with auth header and full payload, revives dates', async () => {
    const calls = mockFetch(() => ({ body: WIRE_INFO }))
    const backend = makeBackend()

    const info = await backend.start('mca.teros.bash', 'mca-teros-bash', 'cbtok', {
      containerMode: 'per-app',
      appId: 'app_1',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:10011/v1/start')
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok-abc')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      mcaId: 'mca.teros.bash',
      containerName: 'mca-teros-bash',
      callbackToken: 'cbtok',
      options: { containerMode: 'per-app', appId: 'app_1' },
    })
    expect(info.startedAt).toBeInstanceOf(Date)
    expect(info.lastUsed).toBeInstanceOf(Date)
    expect(info.startedAt.toISOString()).toBe('2026-07-05T10:00:00.000Z')
    expect(info).toMatchObject({ name: 'mca-teros-bash', hostPort: 13111, status: 'running' })
  })

  it('non-2xx → throws with the agent error message (parity with local errors)', async () => {
    mockFetch(() => ({ status: 500, body: { error: 'docker run failed: boom' } }))
    const backend = makeBackend()

    await expect(backend.start('mca.x', 'mca-x', 'tok')).rejects.toThrow(
      'docker run failed: boom',
    )
  })

  it('agent unreachable → the fetch error propagates', async () => {
    mockFetch(() => new Error('ECONNREFUSED'))
    const backend = makeBackend()

    await expect(backend.start('mca.x', 'mca-x', 'tok')).rejects.toThrow('ECONNREFUSED')
  })
})

describe('isActuallyRunning', () => {
  it('GETs /v1/running with the name URL-encoded and returns the flag', async () => {
    const calls = mockFetch(() => ({ body: { running: true } }))
    const backend = makeBackend()

    expect(await backend.isActuallyRunning('mca-teros-bash')).toBe(true)
    expect(calls[0].url).toBe('http://127.0.0.1:10011/v1/running?name=mca-teros-bash')
    expect(calls[0].init.method).toBe('GET')
  })

  it('agent unreachable or error status → false (never throws)', async () => {
    mockFetch(() => new Error('ECONNREFUSED'))
    expect(await makeBackend().isActuallyRunning('mca-x')).toBe(false)

    mockFetch(() => ({ status: 500, body: { error: 'boom' } }))
    expect(await makeBackend().isActuallyRunning('mca-x')).toBe(false)
  })
})

describe('best-effort operations', () => {
  it('stop POSTs /v1/stop and swallows failures', async () => {
    const calls = mockFetch(() => ({ body: { ok: true } }))
    await makeBackend().stop('mca-x')
    expect(calls[0].url).toBe('http://127.0.0.1:10011/v1/stop')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ containerName: 'mca-x' })

    mockFetch(() => new Error('ECONNREFUSED'))
    await expect(makeBackend().stop('mca-x')).resolves.toBeUndefined()
  })

  it('cleanupOrphans never throws', async () => {
    mockFetch(() => ({ status: 500, body: { error: 'boom' } }))
    await expect(makeBackend().cleanupOrphans()).resolves.toBeUndefined()
  })

  it('releasePort is fire-and-forget: returns void and absorbs failures', async () => {
    const calls = mockFetch(() => new Error('ECONNREFUSED'))
    const backend = makeBackend()

    expect(backend.releasePort(13111)).toBeUndefined()
    // Give the floating promise a tick to run (and NOT produce an unhandled rejection)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ port: 13111 })
  })
})

describe('allocatePort', () => {
  it('POSTs /v1/allocate-port and returns the number', async () => {
    mockFetch(() => ({ body: { port: 13777 } }))
    expect(await makeBackend().allocatePort()).toBe(13777)
  })
})
