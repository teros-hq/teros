/**
 * Unit — DockerContainerBackend (TER-471).
 *
 * Mocked boundary: `child_process.spawn/spawnSync` (via mock.module, same
 * pattern as email-service.test.ts) + the health check's `global.fetch`.
 * Everything else is real code. The SUT runs docker via async spawn
 * (execDocker) — only ensureEgressNetwork still uses spawnSync (once per
 * process).
 *
 * Covers: sanitization (name/port), allocatePort (cross-platform via
 * net.createServer, regression TER-559), EXACT docker run command
 * construction, resource limits (--cpus/--memory), error paths with port
 * release, isActuallyRunning, cleanupOrphans with unsafe-name defense, and
 * waitForHealthy.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

const execFileSyncMock = mock<(cmd: string, args: string[], opts?: unknown) => string>(() => '')
const spawnSyncMock = mock<(cmd: string, args: string[], opts?: unknown) => unknown>(() => ({
  status: 0,
  stdout: 'cid\n',
  stderr: '',
}))

/**
 * Async `spawn` fake: each call consults `spawnScript(args)` to decide
 * {status, stdout, stderr} or `error` (the child's 'error' event, e.g. ENOENT).
 * Emission happens in a microtask so the SUT registers its handlers first
 * (it attaches them synchronously right after spawn()).
 */
type FakeSpawnResult = { status: number | null; stdout?: string; stderr?: string; error?: Error }
const spawnScript = mock<(args: string[]) => FakeSpawnResult>(() => ({
  status: 0,
  stdout: 'cid\n',
  stderr: '',
}))
const spawnMock = mock((_cmd: string, args: string[], _opts?: unknown) => {
  const res = spawnScript(args)
  const dataHandlers: Record<string, (d: string) => void> = {}
  const lifecycle: Record<string, (arg?: unknown) => void> = {}
  const child = {
    stdout: {
      on: (ev: string, cb: (d: string) => void) => {
        if (ev === 'data') dataHandlers.stdout = cb
      },
    },
    stderr: {
      on: (ev: string, cb: (d: string) => void) => {
        if (ev === 'data') dataHandlers.stderr = cb
      },
    },
    once: (ev: string, cb: (arg?: unknown) => void) => {
      lifecycle[ev] = cb
      return child
    },
    kill: () => {},
  }
  queueMicrotask(() => {
    if (res.error) {
      lifecycle.error?.(res.error)
      return
    }
    if (res.stdout) dataHandlers.stdout?.(res.stdout)
    if (res.stderr) dataHandlers.stderr?.(res.stderr)
    lifecycle.close?.(res.status)
  })
  return child
})

/** Args of every docker invocation made via spawn, in order. */
const dockerCalls = () => spawnMock.mock.calls.map((c) => c[1] as string[])
/** Args of the first `docker run` made via spawn. */
const runArgs = () => dockerCalls().find((a) => a[0] === 'run')

// biome-ignore lint/suspicious/noExplicitAny: passthrough del módulo nativo
const realChildProcess = require('node:child_process') as any

// Solo se sustituyen las funciones que usa el SUT; el resto del módulo
// real queda intacto para no romper otros consumidores del import-graph.
mock.module('child_process', () => ({
  ...realChildProcess,
  execFileSync: execFileSyncMock,
  spawnSync: spawnSyncMock,
  spawn: spawnMock,
}))

// `bun test tests/` comparte proceso entre archivos: restaurar el módulo real
// al acabar para no contaminar tests posteriores que usen child_process.
afterAll(() => {
  mock.module('child_process', () => realChildProcess)
})

// `net.createServer` boundary del check de puertos (isPortFree). Lo controla
// `occupiedPorts`: un puerto en el set hace que el bind emita 'error' (ocupado);
// el resto emite 'listening' (libre). Restaurado en afterAll (mock.module es
// global por proceso en bun). TER-559.
const occupiedPorts = new Set<number>()
// biome-ignore lint/suspicious/noExplicitAny: passthrough del módulo nativo
const realNet = require('node:net') as any
mock.module('net', () => ({
  ...realNet,
  createServer: () => {
    const handlers: Record<string, (arg?: unknown) => void> = {}
    return {
      once(ev: string, cb: (arg?: unknown) => void) {
        handlers[ev] = cb
        return this
      },
      listen(port: number) {
        queueMicrotask(() =>
          occupiedPorts.has(port)
            ? handlers.error?.(new Error('EADDRINUSE'))
            : handlers.listening?.(),
        )
        return this
      },
      close(cb?: () => void) {
        cb?.()
      },
    }
  },
}))
afterAll(() => {
  mock.module('net', () => realNet)
})

import {
  assertSafeContainerName,
  assertSafePort,
  DockerContainerBackend,
  type DockerContainerBackendConfig,
} from '../../src/services/docker-container-backend'

function makeConfig(overrides: Partial<DockerContainerBackendConfig> = {}): DockerContainerBackendConfig {
  return {
    mcaBasePath: '/srv/teros/mcas',
    dockerImage: 'teros-mca-runtime:latest',
    hostGateway: null,
    backendPort: 10001,
    portRange: { min: 4000, max: 4002 }, // 2 candidatos → tests deterministas
    ...overrides,
  }
}

const realFetch = global.fetch
let randomSpy: ReturnType<typeof spyOn> | undefined

beforeEach(() => {
  occupiedPorts.clear()
  execFileSyncMock.mockReset()
  execFileSyncMock.mockImplementation(() => '')
  spawnSyncMock.mockReset()
  spawnSyncMock.mockImplementation(() => ({ status: 0, stdout: 'cid\n', stderr: '' }))
  spawnScript.mockReset()
  spawnScript.mockImplementation(() => ({ status: 0, stdout: 'cid\n', stderr: '' }))
  spawnMock.mockClear()
})

afterEach(() => {
  global.fetch = realFetch
  randomSpy?.mockRestore()
  randomSpy = undefined
})

/** Math.random determinista: devuelve la secuencia y luego repite el último. */
function fixRandom(...values: number[]): void {
  let i = 0
  randomSpy = spyOn(Math, 'random').mockImplementation(() => values[Math.min(i++, values.length - 1)])
}

function healthyFetch(): void {
  global.fetch = mock(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
}

// ===========================================================================
// Sanitización
// ===========================================================================

describe('assertSafeContainerName', () => {
  it('acepta nombres docker válidos', () => {
    for (const name of ['mca-teros-bash', 'a', 'A1', 'x.y_z-9', `a${'b'.repeat(254)}`]) {
      expect(() => assertSafeContainerName(name)).not.toThrow()
    }
  })

  it('rechaza vacío, no-string, >255 y metacaracteres de shell', () => {
    expect(() => assertSafeContainerName('')).toThrow('non-empty')
    // biome-ignore lint/suspicious/noExplicitAny: boundary con input no tipado
    expect(() => assertSafeContainerName(42 as any)).toThrow('non-empty')
    expect(() => assertSafeContainerName(`a${'b'.repeat(255)}`)).toThrow('too long')
    for (const name of ['-empieza-mal', '.dot', 'a;b', 'a b', 'a$(x)', 'a|b', 'a`b`', 'a\nb']) {
      expect(() => assertSafeContainerName(name)).toThrow('Invalid container name')
    }
  })
})

describe('assertSafePort', () => {
  it('acepta el rango TCP completo y rechaza el resto', () => {
    expect(() => assertSafePort(1)).not.toThrow()
    expect(() => assertSafePort(65535)).not.toThrow()
    for (const port of [0, 65536, -1, 1.5, Number.NaN]) {
      expect(() => assertSafePort(port)).toThrow('Invalid port number')
    }
  })
})

// ===========================================================================
// allocatePort / releasePort
// ===========================================================================

describe('allocatePort', () => {
  it('devuelve un puerto libre del rango y lo reserva (la 2ª llamada da otro)', async () => {
    fixRandom(0, 0, 0.5) // 4000 · (4000 usado→retry) · 4001
    const backend = new DockerContainerBackend(makeConfig())

    expect(await backend.allocatePort()).toBe(4000)
    expect(await backend.allocatePort()).toBe(4001)
  })

  it('salta un puerto ocupado (bind emite EADDRINUSE)', async () => {
    fixRandom(0, 0.5)
    occupiedPorts.add(4000)
    const backend = new DockerContainerBackend(makeConfig())

    expect(await backend.allocatePort()).toBe(4001)
  })

  it('agotado el rango → "No available ports"', async () => {
    fixRandom(0, 0.5)
    occupiedPorts.add(4000)
    occupiedPorts.add(4001)
    const backend = new DockerContainerBackend(makeConfig())

    await expect(backend.allocatePort()).rejects.toThrow('No available ports in range 4000-4002')
  })

  it('REGRESSION TER-559: comprueba puertos con net.createServer, no con `ss` (cross-platform)', async () => {
    // El bug: `ss -tln` es Linux-only y falta en la imagen alpine del backend →
    // ENOENT en cada candidato → agota el rango aunque haya puertos libres. El fix
    // usa net.createServer (bind real), que no depende de iproute2.
    fixRandom(0)
    execFileSyncMock.mockClear()
    const backend = new DockerContainerBackend(makeConfig())

    expect(await backend.allocatePort()).toBe(4000)
    expect(execFileSyncMock.mock.calls.filter((c) => c[0] === 'ss')).toEqual([])
  })

  it('releasePort devuelve el puerto al pool', async () => {
    fixRandom(0, 0)
    const backend = new DockerContainerBackend(makeConfig())
    const port = await backend.allocatePort()

    backend.releasePort(port)

    expect(await backend.allocatePort()).toBe(port)
  })
})

// ===========================================================================
// start — construcción exacta del docker run
// ===========================================================================

describe('start', () => {
  it('happy path: dockerArgs EXACTOS, rm previo, info running', async () => {
    fixRandom(0)
    healthyFetch()
    const backend = new DockerContainerBackend(makeConfig())

    const info = await backend.start('mca.teros.bash', 'mca-teros-bash', 'tok123')

    // Stale-container cleanup BEFORE the run, then the run — both via spawn
    const calls = dockerCalls()
    expect(calls[0]).toEqual(['rm', '-f', 'mca-teros-bash'])
    expect(calls[1]).toEqual([
      'run', '-d',
      '--name', 'mca-teros-bash',
      '-p', '4000:3000',
      '-v', '/srv/teros/mcas/mca.teros.bash:/app/mca:rw',
      '-v', '/srv/teros/mcas/../packages:/app/packages:ro',
      '-e', 'MCA_TRANSPORT=http',
      '-e', 'MCA_HTTP_PORT=3000',
      '-e', 'MCA_CALLBACK_BASE_URL=http://host.docker.internal:10001',
      '-e', 'MCA_CALLBACK_TOKEN=tok123',
      'teros-mca-runtime:latest',
    ])
    expect(info).toMatchObject({
      name: 'mca-teros-bash',
      mcaId: 'mca.teros.bash',
      hostPort: 4000,
      containerPort: 3000,
      status: 'running',
      baseUrl: 'http://localhost:4000',
    })
  })

  it('hostGateway Linux añade --add-host en la posición correcta', async () => {
    fixRandom(0)
    healthyFetch()
    const backend = new DockerContainerBackend(makeConfig({ hostGateway: '172.17.0.1' }))

    await backend.start('mca.teros.bash', 'mca-teros-bash', 'tok')

    const args = runArgs() as string[]
    const idx = args.indexOf('--add-host=host.docker.internal:172.17.0.1')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx - 2]).toBe('-p') // tras el port mapping, antes de los -v
  })

  it('defaultCpus/defaultMemoryMb del config añaden --cpus/--memory/--memory-swap', async () => {
    fixRandom(0)
    healthyFetch()
    const backend = new DockerContainerBackend(makeConfig({ defaultCpus: 1, defaultMemoryMb: 1024 }))

    await backend.start('mca.x', 'mca-x', 'tok')

    const joined = (runArgs() as string[]).join(' ')
    expect(joined).toContain('--cpus 1')
    // --memory-swap == --memory: no swap, so a leaking MCA gets OOM-killed instead of dragging the host
    expect(joined).toContain('--memory 1024m --memory-swap 1024m')
  })

  it('options.cpus/memoryMb (manifest runtime.resources) pisan el default del config', async () => {
    fixRandom(0)
    healthyFetch()
    const backend = new DockerContainerBackend(makeConfig({ defaultCpus: 1, defaultMemoryMb: 1024 }))

    await backend.start('mca.x', 'mca-x', 'tok', { cpus: 2, memoryMb: 2048 })

    const joined = (runArgs() as string[]).join(' ')
    expect(joined).toContain('--cpus 2')
    expect(joined).toContain('--memory 2048m --memory-swap 2048m')
  })

  it('sin defaults ni options no se añaden flags de recursos (comportamiento previo)', async () => {
    fixRandom(0)
    healthyFetch()
    const backend = new DockerContainerBackend(makeConfig())

    await backend.start('mca.x', 'mca-x', 'tok')

    const joined = (runArgs() as string[]).join(' ')
    expect(joined).not.toContain('--cpus')
    expect(joined).not.toContain('--memory')
  })

  it('options: network, appId, image override, env extra (null saltado), volumes ro/rw', async () => {
    fixRandom(0)
    healthyFetch()
    const backend = new DockerContainerBackend(makeConfig())

    await backend.start('mca.teros.scheduler', 'mca-teros-scheduler', 'tok', {
      dockerNetwork: 'teros_teros-network',
      appId: 'app_abc',
      image: 'custom:1.0',
      // biome-ignore lint/suspicious/noExplicitAny: null intencional para el filtro
      environment: { FOO: 'bar', NADA: null as any },
      volumes: [
        { hostPath: '/data/x', containerPath: '/x', readOnly: true },
        { hostPath: '/data/y', containerPath: '/y' },
      ],
    })

    const args = runArgs() as string[]
    expect(args).toContain('--network')
    expect(args[args.indexOf('--network') + 1]).toBe('teros_teros-network')
    expect(args).toContain('MCA_APP_ID=app_abc')
    expect(args).toContain('FOO=bar')
    expect(args.join(' ')).not.toContain('NADA')
    expect(args).toContain('/data/x:/x:ro')
    expect(args).toContain('/data/y:/y:rw')
    expect(args[args.length - 1]).toBe('custom:1.0') // la imagen SIEMPRE al final
  })

  it('docker run con status != 0 → throw con stderr y el puerto se libera', async () => {
    fixRandom(0, 0)
    spawnScript.mockImplementation((args) =>
      args[0] === 'run' ? { status: 1, stdout: '', stderr: 'boom' } : { status: 0 },
    )
    const backend = new DockerContainerBackend(makeConfig())

    await expect(backend.start('mca.x', 'mca-x', 'tok')).rejects.toThrow('docker run failed: boom')

    // El 4000 quedó liberado: la siguiente asignación lo reusa
    expect(await backend.allocatePort()).toBe(4000)
  })

  it('spawn emite error (docker no instalado) → throw y puerto liberado', async () => {
    fixRandom(0, 0)
    spawnScript.mockImplementation((args) =>
      args[0] === 'run' ? { status: null, error: new Error('ENOENT docker') } : { status: 0 },
    )
    const backend = new DockerContainerBackend(makeConfig())

    await expect(backend.start('mca.x', 'mca-x', 'tok')).rejects.toThrow('ENOENT docker')
    expect(await backend.allocatePort()).toBe(4000)
  })

  it('nombre de contenedor inválido → rechaza ANTES de tocar docker', async () => {
    const backend = new DockerContainerBackend(makeConfig())

    await expect(backend.start('mca.x', 'mca-x; rm -rf /', 'tok')).rejects.toThrow(
      'Invalid container name',
    )
    expect(spawnMock).not.toHaveBeenCalled()
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// ensureEgressNetwork — egress subnet-overlap fallback (fix/egress-subnet-overlap)
// ===========================================================================

describe('ensureEgressNetwork (egress network creation)', () => {
  const TEROS_EGRESS = 'teros_egress'

  // spawnSync answers per docker subcommand (inspect | create); the docker
  // run goes through the async spawn (spawnScript default: status 0).
  function networkScript(opts: {
    exists?: boolean
    fixedStatus?: number
    fixedStderr?: string
    autoStatus?: number
    autoStderr?: string
  }) {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const a = args.join(' ')
      if (a.startsWith('network inspect')) {
        return { status: opts.exists ? 0 : 1, stdout: '', stderr: opts.exists ? '' : 'not found' }
      }
      if (a.startsWith('network create') && a.includes('--subnet')) {
        return { status: opts.fixedStatus ?? 0, stdout: 'netid\n', stderr: opts.fixedStderr ?? '' }
      }
      if (a.startsWith('network create')) {
        return { status: opts.autoStatus ?? 0, stdout: 'netid\n', stderr: opts.autoStderr ?? '' }
      }
      return { status: 0, stdout: 'cid\n', stderr: '' }
    })
  }

  const createCalls = () =>
    spawnSyncMock.mock.calls.filter((c) => (c[1] as string[]).slice(0, 2).join(' ') === 'network create')

  it('subnet fija libre → crea con --subnet, sin fallback', async () => {
    fixRandom(0)
    healthyFetch()
    networkScript({ exists: false, fixedStatus: 0 })
    const backend = new DockerContainerBackend(makeConfig())

    await backend.start('mca.teros.http', 'mca-teros-http', 'tok', { dockerNetwork: TEROS_EGRESS })

    const creates = createCalls()
    expect(creates).toHaveLength(1)
    expect((creates[0][1] as string[]).join(' ')).toContain('--subnet')
  })

  it('"Pool overlaps" en la subnet fija → fallback a subnet auto (sin --subnet); start NO falla', async () => {
    fixRandom(0)
    healthyFetch()
    networkScript({
      exists: false,
      fixedStatus: 1,
      fixedStderr: 'invalid pool request: Pool overlaps with other one on this address space',
      autoStatus: 0,
    })
    const backend = new DockerContainerBackend(makeConfig())

    // Sin el fallback (código previo) esto lanzaría "[EGRESS_NET] failed to create".
    await expect(
      backend.start('mca.teros.http', 'mca-teros-http', 'tok', { dockerNetwork: TEROS_EGRESS }),
    ).resolves.toMatchObject({ status: 'running' })

    const creates = createCalls()
    expect(creates).toHaveLength(2) // intento con subnet fija + fallback auto
    expect((creates[0][1] as string[]).join(' ')).toContain('--subnet')
    expect((creates[1][1] as string[]).join(' ')).not.toContain('--subnet')
  })

  it('red ya existente → no intenta crear', async () => {
    fixRandom(0)
    healthyFetch()
    networkScript({ exists: true })
    const backend = new DockerContainerBackend(makeConfig())

    await backend.start('mca.teros.http', 'mca-teros-http', 'tok', { dockerNetwork: TEROS_EGRESS })

    expect(createCalls()).toEqual([])
  })

  it('ambos creates fallan (no es "already exists") → throw [EGRESS_NET]', async () => {
    fixRandom(0)
    healthyFetch()
    networkScript({
      exists: false,
      fixedStatus: 1,
      fixedStderr: 'Pool overlaps',
      autoStatus: 1,
      autoStderr: 'some other docker error',
    })
    const backend = new DockerContainerBackend(makeConfig())

    await expect(
      backend.start('mca.teros.http', 'mca-teros-http', 'tok', { dockerNetwork: TEROS_EGRESS }),
    ).rejects.toThrow('[EGRESS_NET] failed to create teros_egress')
  })

  it('un create concurrente que pierde la carrera ("already exists") NO lanza', async () => {
    fixRandom(0)
    healthyFetch()
    networkScript({
      exists: false,
      fixedStatus: 1,
      fixedStderr: 'Error response from daemon: network with name teros_egress already exists',
    })
    const backend = new DockerContainerBackend(makeConfig())

    await expect(
      backend.start('mca.teros.http', 'mca-teros-http', 'tok', { dockerNetwork: TEROS_EGRESS }),
    ).resolves.toMatchObject({ status: 'running' })

    // "already exists" en el intento fijo → no se intenta el fallback.
    expect(createCalls()).toHaveLength(1)
  })
})

// ===========================================================================
// stop / isActuallyRunning
// ===========================================================================

describe('stop', () => {
  it('hace docker rm -f y traga el error si ya no existe', async () => {
    const backend = new DockerContainerBackend(makeConfig())
    await backend.stop('mca-teros-bash')
    expect(dockerCalls()[0]).toEqual(['rm', '-f', 'mca-teros-bash'])

    spawnScript.mockImplementation(() => ({ status: null, error: new Error('No such container') }))
    await expect(backend.stop('mca-teros-bash')).resolves.toBeUndefined()
  })

  it('valida el nombre antes del comando', async () => {
    const backend = new DockerContainerBackend(makeConfig())
    await expect(backend.stop('a;b')).rejects.toThrow('Invalid container name')
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe('isActuallyRunning', () => {
  it.each([
    ['true\n', true],
    ['false\n', false],
  ])('inspect devuelve %p → %p', async (output, expected) => {
    spawnScript.mockImplementation(() => ({ status: 0, stdout: output as string }))
    const backend = new DockerContainerBackend(makeConfig())
    expect(await backend.isActuallyRunning('mca-x')).toBe(expected as boolean)
  })

  it('contenedor inexistente (inspect status != 0) → false', async () => {
    spawnScript.mockImplementation(() => ({ status: 1, stderr: 'No such object' }))
    const backend = new DockerContainerBackend(makeConfig())
    expect(await backend.isActuallyRunning('mca-x')).toBe(false)
  })

  it('docker no disponible (spawn emite error) → false', async () => {
    spawnScript.mockImplementation(() => ({ status: null, error: new Error('ENOENT') }))
    const backend = new DockerContainerBackend(makeConfig())
    expect(await backend.isActuallyRunning('mca-x')).toBe(false)
  })
})

// ===========================================================================
// cleanupOrphans
// ===========================================================================

describe('cleanupOrphans', () => {
  it('elimina cada contenedor mca-* listado por docker ps', async () => {
    spawnScript.mockImplementation((args) =>
      args[0] === 'ps' ? { status: 0, stdout: 'mca-a\nmca-b\n' } : { status: 0 },
    )
    const backend = new DockerContainerBackend(makeConfig())

    await backend.cleanupOrphans()

    const rmCalls = dockerCalls().filter((a) => a[0] === 'rm')
    expect(rmCalls.map((a) => a[2])).toEqual(['mca-a', 'mca-b'])
  })

  it('un nombre unsafe devuelto por docker se SALTA pero el resto se limpia', async () => {
    spawnScript.mockImplementation((args) =>
      args[0] === 'ps' ? { status: 0, stdout: 'mca-a\nmca-evil;rm\nmca-b\n' } : { status: 0 },
    )
    const backend = new DockerContainerBackend(makeConfig())

    await backend.cleanupOrphans()

    const rmCalls = dockerCalls().filter((a) => a[0] === 'rm')
    expect(rmCalls.map((a) => a[2])).toEqual(['mca-a', 'mca-b'])
  })

  it('docker ps falla → best-effort, no crashea; sin output → no rm', async () => {
    spawnScript.mockImplementation(() => ({ status: null, error: new Error('docker daemon down') }))
    const backend = new DockerContainerBackend(makeConfig())
    await expect(backend.cleanupOrphans()).resolves.toBeUndefined()

    spawnScript.mockReset()
    spawnScript.mockImplementation(() => ({ status: 0, stdout: '' }))
    spawnMock.mockClear()
    await backend.cleanupOrphans()
    const rmCalls = dockerCalls().filter((a) => a[0] === 'rm')
    expect(rmCalls).toEqual([])
  })
})

// ===========================================================================
// waitForHealthy
// ===========================================================================

describe('waitForHealthy', () => {
  function info(baseUrl = 'http://localhost:4000') {
    return {
      name: 'mca-x',
      mcaId: 'mca.x',
      hostPort: 4000,
      containerPort: 3000,
      status: 'starting' as const,
      startedAt: new Date(),
      lastUsed: new Date(),
      baseUrl,
    }
  }

  it('cualquier status <500 cuenta como healthy (p.ej. 404 del /health ausente)', async () => {
    global.fetch = mock(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    const backend = new DockerContainerBackend(makeConfig())
    // biome-ignore lint/suspicious/noExplicitAny: método privado — patrón del repo
    await expect((backend as any).waitForHealthy(info(), 500)).resolves.toBeUndefined()
  })

  it('5xx NO cuenta como healthy → timeout', async () => {
    global.fetch = mock(async () => new Response('err', { status: 503 })) as unknown as typeof fetch
    const backend = new DockerContainerBackend(makeConfig())
    // biome-ignore lint/suspicious/noExplicitAny: método privado — patrón del repo
    await expect((backend as any).waitForHealthy(info(), 120)).rejects.toThrow(
      'did not become healthy within 120ms',
    )
  })

  it('fetch que lanza (contenedor aún sin puerto) → reintenta hasta timeout', async () => {
    global.fetch = mock(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const backend = new DockerContainerBackend(makeConfig())
    // biome-ignore lint/suspicious/noExplicitAny: método privado — patrón del repo
    await expect((backend as any).waitForHealthy(info(), 120)).rejects.toThrow('did not become healthy')
  })
})
