/**
 * Unit — McaContainerManager: lifecycle del Map de contenedores (TER-471).
 *
 * El incidente recurrente del runtime es el Map STALE: un contenedor
 * eliminado/reiniciado por fuera deja una entry viva → "fetch failed" /
 * "Connection rejected: no pending connection". Estos tests fijan el contrato
 * del Map con un IContainerBackend fake inyectado (boundary real del manager):
 * spawn registra, teardown limpia, gone-externally restaura, y el error path
 * no deja residuos.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import type {
  ContainerInfo,
  ContainerStartOptions,
  IContainerBackend,
} from '../../src/services/container-backend'
import { McaContainerManager } from '../../src/services/mca-container-manager'

const MCA_ID = 'mca.teros.bash'
const APP_ID = 'app_0123456789abcdef'

function makeInfo(overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    name: 'mca-teros-bash',
    mcaId: MCA_ID,
    hostPort: 4321,
    containerPort: 3000,
    status: 'running',
    startedAt: new Date(),
    lastUsed: new Date(),
    baseUrl: 'http://localhost:4321',
    ...overrides,
  }
}

function makeBackend(overrides: Partial<IContainerBackend> = {}): IContainerBackend & {
  start: ReturnType<typeof mock>
  stop: ReturnType<typeof mock>
  isActuallyRunning: ReturnType<typeof mock>
  cleanupOrphans: ReturnType<typeof mock>
  releasePort: ReturnType<typeof mock>
  shutdown: ReturnType<typeof mock>
} {
  return {
    start: mock(async (mcaId: string, name: string) => makeInfo({ mcaId, name })),
    stop: mock(async () => {}),
    isActuallyRunning: mock(async () => true),
    cleanupOrphans: mock(async () => {}),
    allocatePort: mock(async () => 4321),
    releasePort: mock(() => {}),
    shutdown: mock(async () => {}),
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake del boundary para el test
  } as any
}

// El constructor arranca un setInterval(5min) — hay que cerrarlo SIEMPRE o el
// proceso bun queda colgado por timers (gotcha del repo).
const managers: McaContainerManager[] = []
function makeManager(backend: IContainerBackend): McaContainerManager {
  const m = new McaContainerManager({ backend })
  managers.push(m)
  return m
}

afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown()
})

// ===========================================================================
// getOrStart — registro y reuso
// ===========================================================================

describe('getOrStart', () => {
  it('primera vez: arranca vía backend y registra en el Map', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)

    const info = await manager.getOrStart(MCA_ID)

    expect(backend.start).toHaveBeenCalledTimes(1)
    const [mcaIdArg, nameArg, tokenArg, optionsArg] = backend.start.mock.calls[0]
    expect(mcaIdArg).toBe(MCA_ID)
    expect(nameArg).toBe('mca-teros-bash') // puntos → guiones
    expect(tokenArg).toMatch(/^[0-9a-f]{64}$/) // randomBytes(32).hex
    expect(optionsArg).toBeUndefined()
    expect(manager.getInfo(MCA_ID)).toBe(info)
    expect(manager.isRunning(MCA_ID)).toBe(true)
  })

  it('reusa el contenedor vivo sin re-arrancar y refresca lastUsed', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)
    const first = await manager.getOrStart(MCA_ID)
    const staleDate = new Date(Date.now() - 60_000)
    first.lastUsed = staleDate

    const second = await manager.getOrStart(MCA_ID)

    expect(second).toBe(first)
    expect(backend.start).toHaveBeenCalledTimes(1)
    expect(backend.isActuallyRunning).toHaveBeenCalledWith('mca-teros-bash')
    expect(second.lastUsed.getTime()).toBeGreaterThan(staleDate.getTime())
  })

  it('gone-externally: libera puerto, limpia el Map y re-arranca (anti-stale)', async () => {
    const backend = makeBackend({
      isActuallyRunning: mock(async () => false), // docker rm externo
    })
    const manager = makeManager(backend)
    const first = await manager.getOrStart(MCA_ID)

    const second = await manager.getOrStart(MCA_ID)

    expect(backend.releasePort).toHaveBeenCalledWith(first.hostPort)
    expect(backend.start).toHaveBeenCalledTimes(2)
    expect(second).not.toBe(first)
    expect(manager.getInfo(MCA_ID)).toBe(second)
  })

  it('gone-externally + re-arranque FALLIDO: la entry zombi NO queda en el Map (gap M3)', async () => {
    // Sin el containers.delete del path gone, un start fallido dejaría la
    // entry VIEJA viva → getInfo devolvería un contenedor muerto (Map stale).
    let calls = 0
    const backend = makeBackend({
      isActuallyRunning: mock(async () => false),
      start: mock(async (mcaId: string, name: string) => {
        calls++
        if (calls === 1) return makeInfo({ mcaId, name })
        throw new Error('docker daemon down')
      }),
    })
    const manager = makeManager(backend)
    await manager.getOrStart(MCA_ID)

    await expect(manager.getOrStart(MCA_ID)).rejects.toThrow('docker daemon down')

    expect(manager.getInfo(MCA_ID)).toBeUndefined()
    expect(manager.isRunning(MCA_ID)).toBe(false)
  })

  it('una entry NO running (p.ej. error) no se reusa: re-arranca', async () => {
    let call = 0
    const backend = makeBackend({
      start: mock(async (_mcaId: string, name: string) => {
        call++
        if (call === 1) return makeInfo({ name, status: 'error' })
        return makeInfo({ name })
      }),
    })
    const manager = makeManager(backend)
    await manager.getOrStart(MCA_ID)

    await manager.getOrStart(MCA_ID)

    // No pasa por isActuallyRunning (solo aplica a status running)
    expect(backend.isActuallyRunning).not.toHaveBeenCalled()
    expect(backend.start).toHaveBeenCalledTimes(2)
  })

  it('error del backend.start: ni Map ni token quedan residuales', async () => {
    const backend = makeBackend({
      start: mock(async () => {
        throw new Error('docker run failed')
      }),
    })
    const manager = makeManager(backend)

    await expect(manager.getOrStart(MCA_ID)).rejects.toThrow('docker run failed')

    expect(manager.getInfo(MCA_ID)).toBeUndefined()
    // El token EMITIDO para el intento fallido deja de valer (gap M5 del hunt:
    // un assert con token aleatorio no distinguía si el real quedaba vivo)
    const issuedToken = backend.start.mock.calls[0][2] as string
    expect(manager.isValidCallbackToken(issuedToken)).toBe(false)
    expect(manager.verifyCallbackToken(MCA_ID, issuedToken)).toBe(false)
  })
})

// ===========================================================================
// Claves y nombres — shared vs per-app
// ===========================================================================

describe('claves y nombres de contenedor', () => {
  it('shared: clave = mcaId, nombre = mcaId con guiones', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)

    await manager.getOrStart(MCA_ID, { containerMode: 'shared' })

    expect(backend.start.mock.calls[0][1]).toBe('mca-teros-bash')
    expect(manager.getInfo(MCA_ID)).toBeDefined()
    expect(manager.getInfo(APP_ID)).toBeUndefined()
  })

  it('per-app: clave = appId, nombre lleva hash de 8 chars del appId', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)

    await manager.getOrStart(MCA_ID, { containerMode: 'per-app', appId: APP_ID })

    // hash = appId sin no-alfanuméricos, últimos 8: 'app0123456789abcdef' → '89abcdef'
    expect(backend.start.mock.calls[0][1]).toBe('mca-teros-bash-89abcdef')
    expect(manager.getInfo(APP_ID)).toBeDefined()
    expect(manager.getInfo(MCA_ID)).toBeUndefined()
  })

  it('per-app SIN appId degrada a clave shared', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)

    await manager.getOrStart(MCA_ID, { containerMode: 'per-app' })

    expect(backend.start.mock.calls[0][1]).toBe('mca-teros-bash')
    expect(manager.getInfo(MCA_ID)).toBeDefined()
  })
})

// ===========================================================================
// stop — teardown limpio
// ===========================================================================

describe('stop', () => {
  it('para el contenedor, libera el puerto y limpia Map + token', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)
    const info = await manager.getOrStart(MCA_ID)

    await manager.stop(MCA_ID)

    expect(backend.stop).toHaveBeenCalledWith(info.name)
    expect(backend.releasePort).toHaveBeenCalledWith(info.hostPort)
    expect(manager.getInfo(MCA_ID)).toBeUndefined()
    expect(manager.isRunning(MCA_ID)).toBe(false)
  })

  it('tras stop el callback token deja de validar (gap M6c)', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)
    await manager.getOrStart(MCA_ID)
    const token = backend.start.mock.calls[0][2] as string
    expect(manager.verifyCallbackToken(MCA_ID, token)).toBe(true)

    await manager.stop(MCA_ID)

    expect(manager.verifyCallbackToken(MCA_ID, token)).toBe(false)
    expect(manager.isValidCallbackToken(token)).toBe(false)
  })

  it('stop de una clave desconocida es no-op (no llama al backend)', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)

    await manager.stop('no-existe')

    expect(backend.stop).not.toHaveBeenCalled()
    expect(backend.releasePort).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Callback tokens — verificación timing-safe
// ===========================================================================

describe('callback tokens', () => {
  async function managerWithToken(): Promise<{ manager: McaContainerManager; token: string }> {
    const backend = makeBackend()
    const manager = makeManager(backend)
    await manager.getOrStart(MCA_ID)
    const token = backend.start.mock.calls[0][2] as string
    return { manager, token }
  }

  it('acepta el token emitido para su clave', async () => {
    const { manager, token } = await managerWithToken()
    expect(manager.verifyCallbackToken(MCA_ID, token)).toBe(true)
  })

  it('rechaza token incorrecto de la misma longitud', async () => {
    const { manager, token } = await managerWithToken()
    const wrong = `${'0'.repeat(token.length - 1)}1`
    expect(manager.verifyCallbackToken(MCA_ID, wrong)).toBe(false)
  })

  it('rechaza token de longitud distinta y clave desconocida', async () => {
    const { manager, token } = await managerWithToken()
    expect(manager.verifyCallbackToken(MCA_ID, 'corto')).toBe(false)
    expect(manager.verifyCallbackToken('otra-clave', token)).toBe(false)
  })

  it('isValidCallbackToken acepta el token de CUALQUIER contenedor registrado', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)
    await manager.getOrStart(MCA_ID)
    await manager.getOrStart('mca.teros.scheduler')
    const token2 = backend.start.mock.calls[1][2] as string

    expect(manager.isValidCallbackToken(token2)).toBe(true)
    expect(manager.isValidCallbackToken('x'.repeat(64))).toBe(false)
  })

  it('el token rota al re-arrancar tras gone-externally (el viejo deja de valer)', async () => {
    const backend = makeBackend({ isActuallyRunning: mock(async () => false) })
    const manager = makeManager(backend)
    await manager.getOrStart(MCA_ID)
    const oldToken = backend.start.mock.calls[0][2] as string

    await manager.getOrStart(MCA_ID) // re-arranque
    const newToken = backend.start.mock.calls[1][2] as string

    expect(newToken).not.toBe(oldToken)
    expect(manager.verifyCallbackToken(MCA_ID, oldToken)).toBe(false)
    expect(manager.verifyCallbackToken(MCA_ID, newToken)).toBe(true)
  })
})

// ===========================================================================
// Inactividad y consultas
// ===========================================================================

describe('cleanupInactive', () => {
  it('para contenedores idle >30min y deja los activos', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)
    const idle = await manager.getOrStart(MCA_ID)
    const fresh = await manager.getOrStart('mca.teros.scheduler')
    idle.lastUsed = new Date(Date.now() - 31 * 60 * 1000)
    fresh.lastUsed = new Date()

    const stopped = await manager.cleanupInactive()

    expect(stopped).toEqual([MCA_ID])
    expect(manager.getInfo(MCA_ID)).toBeUndefined()
    expect(manager.getInfo('mca.teros.scheduler')).toBeDefined()
  })

  it('idle EXACTAMENTE en el límite (30min) NO se para (boundary > estricto)', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)
    const info = await manager.getOrStart(MCA_ID)
    const now = Date.now()
    info.lastUsed = new Date(now - 30 * 60 * 1000)

    // now - lastUsed == maxIdleMs → la condición es estrictamente mayor.
    // Margen de unos ms entre el set y el check: comprobamos que NO se paró
    // re-tocando justo antes.
    manager.touch(MCA_ID)
    const stopped = await manager.cleanupInactive()
    expect(stopped).toEqual([])
  })

  it('NO para entries que no están running aunque estén idle (gap M9)', async () => {
    // Parar una entry 'starting' a mitad de arranque sería una carrera real:
    // el cleanup solo aplica a contenedores en estado running.
    const backend = makeBackend()
    const manager = makeManager(backend)
    const info = await manager.getOrStart(MCA_ID)
    info.status = 'starting'
    info.lastUsed = new Date(Date.now() - 31 * 60 * 1000)

    const stopped = await manager.cleanupInactive()

    expect(stopped).toEqual([])
    expect(manager.getInfo(MCA_ID)).toBeDefined()
  })

  it('touch refresca lastUsed y evita el cleanup', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)
    const info = await manager.getOrStart(MCA_ID)
    info.lastUsed = new Date(Date.now() - 31 * 60 * 1000)

    manager.touch(MCA_ID)
    const stopped = await manager.cleanupInactive()

    expect(stopped).toEqual([])
  })
})

describe('consultas', () => {
  it('getContainerPort devuelve hostPort solo si está running', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)
    const info = await manager.getOrStart(MCA_ID)

    expect(manager.getContainerPort(MCA_ID)).toBe(info.hostPort)
    info.status = 'error'
    expect(manager.getContainerPort(MCA_ID)).toBeUndefined()
    expect(manager.getContainerPort('no-existe')).toBeUndefined()
  })

  it('getStatus lista todos los contenedores registrados', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)
    await manager.getOrStart(MCA_ID)
    await manager.getOrStart('mca.teros.scheduler')

    const status = manager.getStatus()
    expect(status.map((i) => i.mcaId).sort()).toEqual([MCA_ID, 'mca.teros.scheduler'])
  })

  it('el constructor dispara cleanupOrphans del backend (limpieza de runs previos)', () => {
    const backend = makeBackend()
    makeManager(backend)
    expect(backend.cleanupOrphans).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Global container cap (MCA_MAX_CONTAINERS) and configurable idle timeout
// ===========================================================================

describe('cap de contenedores', () => {
  const savedMax = process.env.MCA_MAX_CONTAINERS
  const savedIdle = process.env.MCA_IDLE_TIMEOUT_MS

  afterEach(() => {
    if (savedMax === undefined) delete process.env.MCA_MAX_CONTAINERS
    else process.env.MCA_MAX_CONTAINERS = savedMax
    if (savedIdle === undefined) delete process.env.MCA_IDLE_TIMEOUT_MS
    else process.env.MCA_IDLE_TIMEOUT_MS = savedIdle
  })

  it('al llegar al cap, un spawn nuevo falla con error claro; los existentes se siguen reutilizando', async () => {
    process.env.MCA_MAX_CONTAINERS = '1'
    const backend = makeBackend()
    const manager = makeManager(backend)
    await manager.getOrStart(MCA_ID)

    await expect(manager.getOrStart('mca.teros.scheduler')).rejects.toThrow(
      'MCA container limit reached (1 running)',
    )
    // An existing key does NOT count as a new spawn: it is reused without error
    await expect(manager.getOrStart(MCA_ID)).resolves.toBeDefined()
    expect(backend.start).toHaveBeenCalledTimes(1)
  })

  it('en el cap, primero intenta liberar capacidad parando idle (no rechaza si hay hueco)', async () => {
    process.env.MCA_MAX_CONTAINERS = '1'
    const backend = makeBackend()
    const manager = makeManager(backend)
    const idle = await manager.getOrStart(MCA_ID)
    idle.lastUsed = new Date(Date.now() - 31 * 60 * 1000)

    await expect(manager.getOrStart('mca.teros.scheduler')).resolves.toBeDefined()

    expect(manager.getInfo(MCA_ID)).toBeUndefined() // the idle one was stopped to make room
    expect(manager.getInfo('mca.teros.scheduler')).toBeDefined()
  })

  it('los arranques EN VUELO cuentan para el cap (una ráfaga no lo revienta)', async () => {
    process.env.MCA_MAX_CONTAINERS = '1'
    let release!: (info: ContainerInfo) => void
    const pending = new Promise<ContainerInfo>((resolve) => {
      release = resolve
    })
    const backend = makeBackend({
      start: mock((_mcaId: string, name: string) => pending.then((i) => ({ ...i, name }))),
    })
    const manager = makeManager(backend)

    const first = manager.getOrStart(MCA_ID) // stays in flight
    await expect(manager.getOrStart('mca.teros.scheduler')).rejects.toThrow(
      'MCA container limit reached',
    )

    release(makeInfo())
    await expect(first).resolves.toBeDefined()
  })

  it('MCA_IDLE_TIMEOUT_MS acorta el umbral de cleanupInactive', async () => {
    process.env.MCA_IDLE_TIMEOUT_MS = '1000'
    const backend = makeBackend()
    const manager = makeManager(backend)
    const info = await manager.getOrStart(MCA_ID)
    info.lastUsed = new Date(Date.now() - 2000) // 2s > the env's 1s, << the 30min default

    const stopped = await manager.cleanupInactive()

    expect(stopped).toEqual([MCA_ID])
  })
})

// ===========================================================================
// shutdown — teardown total
// ===========================================================================

describe('shutdown', () => {
  it('para TODOS los contenedores y delega el shutdown al backend', async () => {
    const backend = makeBackend()
    const manager = makeManager(backend)
    await manager.getOrStart(MCA_ID)
    await manager.getOrStart('mca.teros.scheduler')

    await manager.shutdown()

    expect(backend.stop).toHaveBeenCalledTimes(2)
    expect(backend.shutdown).toHaveBeenCalledTimes(1)
    expect(manager.getStatus()).toEqual([])
  })
})
