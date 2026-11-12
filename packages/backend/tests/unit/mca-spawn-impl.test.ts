/**
 * Unit — mca-manager.spawn-impl: buildExecutionConfig + spawnContainer (TER-471).
 *
 * Boundary mockeado: `McaHttpClient` (vía mock.module — el discovery HTTP) y
 * el SpawnContext fake con containerManager/volumeService/secretsManager
 * controlables. El resto (interpolación de env, kebab-case de tools, replace
 * de MONGODB_URI, derivación de MCA_BACKEND_URL) es el código real.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { delimiter, join } from 'path'

const listToolsMock = mock(async () => ({
  tools: [] as Array<{ name: string; description?: string; parameters?: { properties?: Record<string, unknown>; required?: string[] } }>,
}))
const httpClientInstances: Array<{ baseUrl: string }> = []

// Capturar el módulo REAL antes de mockear: `bun test tests/` corre todos los
// archivos en el mismo proceso y mock.module persiste — sin el restore del
// afterAll, el test real de McaHttpClient (signal propagation) recibe el fake.
const realMcaHttpClientModule = { ...(await import('../../src/services/mca-http-client')) }

mock.module('../../src/services/mca-http-client', () => ({
  McaHttpClient: class {
    baseUrl: string
    constructor(opts: { baseUrl: string }) {
      this.baseUrl = opts.baseUrl
      httpClientInstances.push({ baseUrl: opts.baseUrl })
    }
    listTools = listToolsMock
  },
}))

afterAll(() => {
  mock.module('../../src/services/mca-http-client', () => realMcaHttpClientModule)
})

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SpawnContext } from '../../src/services/mca-manager.spawn'
import { buildExecutionConfig, spawnContainer } from '../../src/services/mca-manager.spawn-impl'
import type { App, McpCatalogEntry } from '../../src/types/database'

const APP_ID = 'app_0123456789abcdef'
const WORKSPACE_ID = 'work_aaaaaaaaaaaaaaaa'

function makeApp(overrides: Partial<App> = {}): App {
  return {
    appId: APP_ID,
    name: 'bash',
    mcaId: 'mca.teros.bash',
    ownerId: WORKSPACE_ID,
    ownerType: 'workspace',
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fixture parcial del tipo DB
  } as any
}

function makeMca(overrides: Record<string, unknown> = {}): McpCatalogEntry {
  return {
    mcaId: 'mca.teros.bash',
    execution: { command: 'bun', args: ['index.ts'], cwd: 'mca.teros.bash' },
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fixture parcial del catálogo
  } as any
}

interface CtxOptions {
  withConnectionManager?: boolean
  secrets?: Record<string, unknown> | undefined
  userAuth?: Record<string, unknown> | null
  authManagerThrows?: boolean
  workspaceVolumeHostPath?: string
}

function makeCtx(opts: CtxOptions = {}): {
  ctx: SpawnContext
  getOrStartMock: ReturnType<typeof mock>
} {
  const getOrStartMock = mock(async (_mcaId: string, _options: unknown) => ({
    name: 'mca-teros-bash',
    mcaId: 'mca.teros.bash',
    hostPort: 4000,
    containerPort: 3000,
    status: 'running' as const,
    startedAt: new Date(),
    lastUsed: new Date(),
    baseUrl: 'http://localhost:4000',
  }))

  const volumeHostPath = opts.workspaceVolumeHostPath ?? '/srv/volumes/vol_work_1'
  const volumeService = {
    db: {
      collection: () => ({
        findOne: async (filter: { workspaceId: string }) =>
          filter.workspaceId === WORKSPACE_ID ? { workspaceId: WORKSPACE_ID, volumeId: 'vol_work_1' } : null,
      }),
    },
    getVolume: async (id: string) => (id === 'vol_work_1' ? { hostPath: volumeHostPath } : null),
    resolveVolumeMounts: mock(async () => [
      { hostPath: '/srv/volumes/vol_work_1', containerPath: '/workspace', readOnly: false },
    ]),
  }

  const authManager = {
    get: mock(async () => {
      if (opts.authManagerThrows) throw new Error('decrypt failed')
      return opts.userAuth === undefined ? { token: 'user-tok' } : opts.userAuth
    }),
  }

  const ctx: SpawnContext = {
    mcas: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: fake mínimo del service
    mcaService: { workspaceService: {
      getWorkspace: async (id: string) => (id === WORKSPACE_ID ? { workspaceId: WORKSPACE_ID, volumeId: 'vol_work_1' } : null),
    }, authManager } as any,
    // biome-ignore lint/suspicious/noExplicitAny: fake mínimo del manager.
    // getCallbackToken/stop: required since f7a53c0e0 (stale callback tokens,
    // incident-2026-08-14 Layer B) — spawn-impl signs HTTP requests with the
    // per-container callback token and may stop+restart to get a fresh one.
    containerManager: {
      getOrStart: getOrStartMock,
      getCallbackToken: mock(() => 'test-callback-token'),
      stop: mock(async () => {}),
      // stdio callback-token registration (401 storm fix, 2026-09-20..24) —
      // buildExecutionConfig registers a per-app token for stdio MCAs.
      registerCallbackToken: mock(() => {}),
      unregisterCallbackToken: mock(() => {}),
    } as any,
    httpClients: new Map(),
    connectionManager: opts.withConnectionManager === false
      ? undefined
      // biome-ignore lint/suspicious/noExplicitAny: fake mínimo
      : ({ registerPendingConnection: mock(() => 'ws-token-123') } as any),
    isShuttingDown: false,
    containerBackendHost: 'host.docker.internal',
    // Mongo host is DISTINCT from the backend host: Mongo is loopback-published on
    // the host, so internal MCAs reach it via the compose service DNS `mongodb`, not
    // via the bridge gateway (host.docker.internal). See mca-manager.ts.
    containerMongoHost: 'mongodb',
    // biome-ignore lint/suspicious/noExplicitAny: config parcial requerida
    config: {
      mcaBasePath: '/srv/teros/mcas',
      serverPort: 10001,
      // getMcaFresh mirrors mca here: the SUT reads secrets fresh from disk since 031c1ba7f,
      // but in tests both entry points return the same fake secrets.
      secretsManager: {
        mca: mock(() => opts.secrets ?? { api_key: 'K1', vacio: null }),
        getMcaFresh: mock(() => opts.secrets ?? { api_key: 'K1', vacio: null }),
      },
      volumeService,
    } as any,
    setupStderrLogging: mock(() => {}),
    toEnvKey: (prefix, key) => `${prefix}_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
    performInitialHealthCheck: mock(async () => {}),
  }
  return { ctx, getOrStartMock }
}

// process.env que el SUT lee — fijado por test y restaurado siempre.
const ENV_KEYS = [
  'MONGODB_URI',
  'MCA_MONGODB_URI',
  'MONGODB_DATABASE',
  'MONGODB_DB_NAME',
  'STATIC_BASE_URL',
  // buildExecutionConfig spreads process.env into the child environment, and
  // spawn-impl may SET these keys on it. When the suite runs INSIDE an MCA
  // container (e.g. an agent going through a host-exec MCA), the inherited MCA_* env leaks into
  // the "no connectionManager → undefined" assertion and fails it. Wipe them
  // per-test so the suite is hermetic anywhere it runs.
  'MCA_WS_URL',
  'MCA_WS_TOKEN',
  'MCA_BACKEND_URL',
  'MCA_CALLBACK_URL',
  'MCA_APP_ID',
  // buildExecutionConfig now GENERATES these per-spawn for stdio MCAs (401
  // storm fix) — wipe inherited values so assertions are hermetic.
  'MCA_CALLBACK_TOKEN',
  'MCA_WORKSPACE_ID',
] as const
const envBackup: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    envBackup[k] = process.env[k]
    delete process.env[k]
  }
  listToolsMock.mockReset()
  listToolsMock.mockImplementation(async () => ({ tools: [] }))
  httpClientInstances.length = 0
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k]
    else process.env[k] = envBackup[k]
  }
})

// ===========================================================================
// buildExecutionConfig
// ===========================================================================

describe('buildExecutionConfig', () => {
  it('command/args del manifest y cwd = base + execution.cwd (o base si falta)', async () => {
    const { ctx } = makeCtx()
    const cfg = await buildExecutionConfig(ctx, makeApp(), makeMca())
    expect(cfg.command).toBe('bun')
    expect(cfg.args).toEqual(['index.ts'])
    expect(cfg.cwd).toBe('/srv/teros/mcas/mca.teros.bash')

    const sinCwd = await buildExecutionConfig(ctx, makeApp(), makeMca({ execution: { command: 'node', args: [] } }))
    expect(sinCwd.cwd).toBe('/srv/teros/mcas')
  })

  it('env base de identidad del app + MCA_WORKSPACE_PATH resuelta del volumen', async () => {
    const { ctx } = makeCtx()
    const { environment } = await buildExecutionConfig(ctx, makeApp(), makeMca())
    expect(environment.MCA_APP_ID).toBe(APP_ID)
    expect(environment.MCA_APP_NAME).toBe('bash')
    expect(environment.MCA_MCP_ID).toBe('mca.teros.bash')
    expect(environment.MCA_CWD).toBe('/srv/teros/mcas/mca.teros.bash')
    expect(environment.MCA_OWNER_ID).toBe(WORKSPACE_ID)
    expect(environment.MCA_OWNER_TYPE).toBe('workspace')
    expect(environment.MCA_WORKSPACE_PATH).toBe('/srv/volumes/vol_work_1')
  })

  it('MCA_WS_URL/TOKEN solo si hay connectionManager (stdio usa localhost)', async () => {
    const { ctx } = makeCtx()
    const { environment } = await buildExecutionConfig(ctx, makeApp(), makeMca())
    expect(environment.MCA_WS_URL).toBe(
      `ws://localhost:10001/mca?appId=${APP_ID}&token=ws-token-123`,
    )
    expect(environment.MCA_WS_TOKEN).toBe('ws-token-123')

    const { ctx: sinCm } = makeCtx({ withConnectionManager: false })
    const { environment: env2 } = await buildExecutionConfig(sinCm, makeApp(), makeMca())
    expect(env2.MCA_WS_URL).toBeUndefined()
    expect(env2.MCA_WS_TOKEN).toBeUndefined()
  })

  it('MCA_BACKEND_URL derivada de STATIC_BASE_URL; fallback a localhost:puerto', async () => {
    const { ctx } = makeCtx()
    process.env.STATIC_BASE_URL = 'https://be.teros.ai/static'
    const { environment } = await buildExecutionConfig(ctx, makeApp(), makeMca())
    expect(environment.MCA_BACKEND_URL).toBe('https://be.teros.ai')

    delete process.env.STATIC_BASE_URL
    const { environment: env2 } = await buildExecutionConfig(ctx, makeApp(), makeMca())
    expect(env2.MCA_BACKEND_URL).toBe('http://localhost:10001')
    expect(env2.MCA_CALLBACK_URL).toBe(`http://localhost:10001/mca/callback/${APP_ID}`)
  })

  it('SECRET_MCA_* con toEnvKey y sin claves null', async () => {
    const { ctx } = makeCtx({ secrets: { api_key: 'K1', 'weird-key': 'W', vacio: null, indef: undefined } })
    const { environment } = await buildExecutionConfig(ctx, makeApp(), makeMca())
    expect(environment.SECRET_MCA_API_KEY).toBe('K1')
    expect(environment.SECRET_MCA_WEIRD_KEY).toBe('W')
    expect('SECRET_MCA_VACIO' in environment).toBe(false)
    expect('SECRET_MCA_INDEF' in environment).toBe(false)
  })

  it('SECRET_USER_* desde AuthManager (override de app.auth)', async () => {
    const { ctx } = makeCtx({ userAuth: { access_token: 'fresh' } })
    const app = makeApp({ auth: { access_token: 'stale-legacy' } })
    const { environment } = await buildExecutionConfig(ctx, app, makeMca())
    expect(environment.SECRET_USER_ACCESS_TOKEN).toBe('fresh')
  })

  it('AuthManager falla o devuelve null → fallback al app.auth legacy', async () => {
    const { ctx } = makeCtx({ authManagerThrows: true })
    const app = makeApp({ auth: { access_token: 'legacy' } })
    const { environment } = await buildExecutionConfig(ctx, app, makeMca())
    expect(environment.SECRET_USER_ACCESS_TOKEN).toBe('legacy')

    const { ctx: ctxNull } = makeCtx({ userAuth: null })
    const { environment: env2 } = await buildExecutionConfig(ctxNull, app, makeMca())
    expect(env2.SECRET_USER_ACCESS_TOKEN).toBe('legacy')
  })

  it('antepone node_modules/.bin al PATH heredado (bare `tsx` resoluble bajo pm2 → tsx)', async () => {
    const { ctx } = makeCtx()
    const { environment } = await buildExecutionConfig(ctx, makeApp(), makeMca())
    // El PATH heredado de process.env sigue presente al final...
    expect(environment.PATH).toContain(process.env.PATH as string)
    // ...pero con los .bin del backend y del repo antepuestos, para que un backend
    // lanzado directamente (pm2 → tsx) resuelva comandos de catálogo bare como `tsx`.
    const segments = (environment.PATH as string).split(delimiter)
    expect(segments[0].endsWith(join('node_modules', '.bin'))).toBe(true)
    expect(segments[1].endsWith(join('node_modules', '.bin'))).toBe(true)
    // El PATH heredado arranca justo después de los dos .bin antepuestos.
    expect(environment.PATH).toBe(
      `${segments[0]}${delimiter}${segments[1]}${delimiter}${process.env.PATH}`,
    )
  })

  // ── 401 storm fix (2026-09-20..24): stdio MCAs need a callback token ──────
  // Before the fix, buildExecutionConfig never set MCA_CALLBACK_TOKEN, so the
  // SDK sent no Authorization header and authenticateCallback rejected every
  // MCA→backend callback with 401 (the stdio MCA of the time, 111 failures).
  it('genera un MCA_CALLBACK_TOKEN de 64 hex y lo registra en containerManager bajo appId', async () => {
    const { ctx } = makeCtx()
    const { environment } = await buildExecutionConfig(ctx, makeApp(), makeMca())

    expect(environment.MCA_CALLBACK_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    // Registered under the appId — the key authenticateCallback tries first
    // (mirrors per-app container mode), with the mcaId for identity resolution.
    // biome-ignore lint/suspicious/noExplicitAny: fake del boundary
    const cm = ctx.containerManager as any
    expect(cm.registerCallbackToken).toHaveBeenCalledTimes(1)
    expect(cm.registerCallbackToken).toHaveBeenCalledWith(
      APP_ID,
      environment.MCA_CALLBACK_TOKEN,
      'mca.teros.bash',
    )
  })

  it('cada spawn genera un token DISTINTO (token fresco tras restart/respawn — nunca stale)', async () => {
    const { ctx } = makeCtx()
    const { environment: env1 } = await buildExecutionConfig(ctx, makeApp(), makeMca())
    const { environment: env2 } = await buildExecutionConfig(ctx, makeApp(), makeMca())
    expect(env1.MCA_CALLBACK_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(env2.MCA_CALLBACK_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(env1.MCA_CALLBACK_TOKEN).not.toBe(env2.MCA_CALLBACK_TOKEN)
  })

  it('MCA_WORKSPACE_ID = app.ownerId (el SDK la lee para scope de ctx.volume — bug encadenado)', async () => {
    const { ctx } = makeCtx()
    const { environment } = await buildExecutionConfig(ctx, makeApp(), makeMca())
    // stdio-server.ts: workspaceId = MCA_WORKSPACE_ID || MCA_USER_ID || 'unknown'
    // — sin esta var los callbacks de volumen resolvían 'unknown' → ENOENT.
    expect(environment.MCA_WORKSPACE_ID).toBe(WORKSPACE_ID)
  })

  it('spawn sin registerCallbackToken disponible NO rompe (degrada con warn, token igualmente inyectado)', async () => {
    const { ctx } = makeCtx()
    // biome-ignore lint/suspicious/noExplicitAny: fake sin el método nuevo
    ;(ctx.containerManager as any).registerCallbackToken = undefined
    const { environment } = await buildExecutionConfig(ctx, makeApp(), makeMca())
    // El token se inyecta igual — el MCA lo enviará; si el manager no registra,
    // los callbacks 401 (modo de fallo previo, nunca peor) pero el spawn vive.
    expect(environment.MCA_CALLBACK_TOKEN).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ===========================================================================
// spawnContainer
// ===========================================================================

describe('spawnContainer', () => {
  it('arranque OK resetea restartCount a 0 (un MCA que se recupera tras fallos) — TER-559', async () => {
    const { ctx } = makeCtx()
    listToolsMock.mockImplementation(async () => ({ tools: [] }))

    // Llega con restartCount=2 (2 reintentos previos); al arrancar OK debe limpiarse.
    // Si no, un futuro fallo lo llevaría al tope (maxRestarts) antes de tiempo.
    const managed = await spawnContainer(ctx, APP_ID, makeApp(), makeMca(), 2)

    expect(managed.status).toBe('ready')
    expect(managed.restartCount).toBe(0)
  })

  it('happy: placeholder starting → ready; environment y client registrados', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    listToolsMock.mockImplementation(async () => ({
      tools: [
        { name: 'read_email', description: 'Lee', parameters: { properties: { id: { type: 'string' } }, required: ['id'] } },
        { name: '_health_check', description: 'interna' },
      ],
    }))

    const managed = await spawnContainer(ctx, APP_ID, makeApp(), makeMca(), 0)

    expect(ctx.mcas.get(APP_ID)).toBe(managed)
    expect(managed.status).toBe('ready')
    expect(managed.containerKey).toBe('mca.teros.bash') // shared por defecto
    expect(ctx.httpClients.has(APP_ID)).toBe(true)
    expect(httpClientInstances).toEqual([{ baseUrl: 'http://localhost:4000' }])

    // Discovery: kebab + prefijo del app name; interna _ fuera de tools pero en mapping
    expect(managed.tools.map((t) => t.name)).toEqual(['bash_read-email'])
    expect(managed.tools[0].input_schema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    })
    expect(managed.toolNameMapping.get('bash_read-email')).toBe('read_email')
    expect(managed.toolNameMapping.get('bash_-health-check')).toBe('_health_check')

    const [mcaIdArg, optionsArg] = getOrStartMock.mock.calls[0]
    expect(mcaIdArg).toBe('mca.teros.bash')
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const env = (optionsArg as any).environment
    expect(env.MCA_APP_NAME).toBe('bash')
    expect(env.MCA_MCP_ID).toBe('mca.teros.bash')
    expect(env.MCA_OWNER_ID).toBe(WORKSPACE_ID)
    expect(env.MCA_OWNER_TYPE).toBe('workspace')
    expect(env.MCA_WS_URL).toBe(`ws://host.docker.internal:10001/mca?appId=${APP_ID}&token=ws-token-123`)
    expect(env.MCA_BACKEND_URL).toBe('http://localhost:10001')
  })

  it('MONGODB_URI reescribe localhost → containerMongoHost (service DNS alcanzable desde el contenedor)', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.MONGODB_DATABASE = 'teros'

    await spawnContainer(ctx, APP_ID, makeApp(), makeMca(), 0)

    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const env = (getOrStartMock.mock.calls[0][1] as any).environment
    // containerMongoHost === 'mongodb' en el harness (makeCtx): el host de Mongo es el
    // service DNS de compose, NO el backend host (host.docker.internal), porque Mongo
    // está publicado en el loopback del host y rechaza el gateway del bridge.
    expect(env.MONGODB_URI).toBe('mongodb://mongodb:27017')
    expect(env.MONGODB_DATABASE).toBe('teros')
    // El nombre de DB se inyecta bajo AMBOS nombres de env que leen los MCAs.
    expect(env.MONGODB_DB_NAME).toBe('teros')
  })

  it('inyecta un MONGODB_URI alcanzable por defecto aunque el backend no tenga MONGODB_URI', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    // process.env.MONGODB_URI está sin definir (borrado en beforeEach): antes el
    // contenedor caía a su propio localhost:27017 → ECONNREFUSED ::1/127.0.0.1.

    await spawnContainer(ctx, APP_ID, makeApp(), makeMca(), 0)

    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const env = (getOrStartMock.mock.calls[0][1] as any).environment
    expect(env.MONGODB_URI).toBe('mongodb://mongodb:27017')
    expect(env.MONGODB_DATABASE).toBe('teros')
    expect(env.MONGODB_DB_NAME).toBe('teros')
  })

  it('la reescritura toca SOLO el host del authority — credenciales, path y authSource intactos', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    // 'localhost' aparece en password, db-name y authSource: un replace global
    // sobre toda la URI los corrompería (auth rota / DB distinta).
    process.env.MONGODB_URI =
      'mongodb://svc:localhost-pw@localhost:27017,127.0.0.1:27018/localhost_meta?authSource=localhost'
    process.env.MONGODB_DATABASE = 'teros'

    await spawnContainer(ctx, APP_ID, makeApp(), makeMca(), 0)

    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const env = (getOrStartMock.mock.calls[0][1] as any).environment
    expect(env.MONGODB_URI).toBe(
      'mongodb://svc:localhost-pw@mongodb:27017,mongodb:27018/localhost_meta?authSource=localhost',
    )
  })

  it('NO reescribe un MONGODB_URI que ya apunta a un service name (compose/k8s)', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    process.env.MONGODB_URI = 'mongodb://mongodb:27017'
    process.env.MONGODB_DATABASE = 'teros'

    await spawnContainer(ctx, APP_ID, makeApp(), makeMca(), 0)

    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const env = (getOrStartMock.mock.calls[0][1] as any).environment
    // Sin 'localhost' que reescribir → se inyecta tal cual.
    expect(env.MONGODB_URI).toBe('mongodb://mongodb:27017')
  })

  it('MCA_MONGODB_URI (override de ejecución remota) se usa VERBATIM, sin reescritura', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    // El backend apunta a localhost, pero la máquina de ejecución remota alcanza
    // Mongo por su red privada — el override debe pasarse tal cual, sin tocar el host.
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.MCA_MONGODB_URI = 'mongodb://mongo.private.svc:27017/teros'
    process.env.MONGODB_DATABASE = 'teros'

    await spawnContainer(ctx, APP_ID, makeApp(), makeMca(), 0)

    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const env = (getOrStartMock.mock.calls[0][1] as any).environment
    expect(env.MONGODB_URI).toBe('mongodb://mongo.private.svc:27017/teros')
  })

  it('reescribe el loopback IPv6 [::1] (el replace de substring anterior lo dejaba pasar)', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    process.env.MONGODB_URI = 'mongodb://[::1]:27017/teros'
    process.env.MONGODB_DATABASE = 'teros'

    await spawnContainer(ctx, APP_ID, makeApp(), makeMca(), 0)

    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const env = (getOrStartMock.mock.calls[0][1] as any).environment
    // [::1] resuelve al loopback del propio contenedor → debe reescribirse al host alcanzable.
    expect(env.MONGODB_URI).toBe('mongodb://mongodb:27017/teros')
  })

  it('NO corrompe un hostname que solo CONTIENE "localhost" como substring', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    // Match por host completo, no por substring: 'localhost.corp.net' NO es loopback.
    process.env.MONGODB_URI = 'mongodb://localhost.corp.net:27017/teros'
    process.env.MONGODB_DATABASE = 'teros'

    await spawnContainer(ctx, APP_ID, makeApp(), makeMca(), 0)

    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const env = (getOrStartMock.mock.calls[0][1] as any).environment
    expect(env.MONGODB_URI).toBe('mongodb://localhost.corp.net:27017/teros')
  })

  it('systemEnvironment interpola ${SECRET_MCA_*} de secrets y $VAR de process.env; inexistente → ""', async () => {
    const { ctx, getOrStartMock } = makeCtx({ secrets: { waha_api_key: 'SECRETO' } })
    process.env.STATIC_BASE_URL = 'https://be.teros.ai/static'

    await spawnContainer(
      ctx,
      APP_ID,
      makeApp(),
      makeMca({
        runtime: {
          transport: 'http',
          systemEnvironment: {
            WAHA_API_KEY: '${SECRET_MCA_WAHA_API_KEY}',
            BASE: '$STATIC_BASE_URL',
            MISSING: '${NO_EXISTE_XYZ}',
            MIXTO: 'pre-${SECRET_MCA_WAHA_API_KEY}-post',
          },
        },
      }),
      0,
    )

    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const env = (getOrStartMock.mock.calls[0][1] as any).environment
    expect(env.WAHA_API_KEY).toBe('SECRETO')
    expect(env.BASE).toBe('https://be.teros.ai/static')
    expect(env.MISSING).toBe('')
    expect(env.MIXTO).toBe('pre-SECRETO-post')
  })

  // mca.whatsapp is private-only (publish.allowlist): the public tree has no manifest to read.
  const whatsappManifestPath = resolve(__dirname, '../../../../mcas/mca.whatsapp/manifest.json')
  it.skipIf(!existsSync(whatsappManifestPath))('mca.whatsapp/manifest.json (real, post-WS2-saneo) resuelve WAHA_API_KEY + proxy Bright Data desde .secrets/mcas/mca.whatsapp/credentials.json — regression WS2/TER-719', async () => {
    // Lee el manifest REAL del árbol, no un fixture sintético: si alguien renombra
    // una key de systemEnvironment sin tocar el .example.json a juego, esto rompe.
    const realManifest = JSON.parse(readFileSync(whatsappManifestPath, 'utf-8'))
    // biome-ignore lint/suspicious/noTemplateCurlyInString: afirma el placeholder LITERAL del manifest, no una interpolación
    expect(realManifest.runtime.systemEnvironment.WAHA_API_KEY).toBe('${SECRET_MCA_WAHA_API_KEY}')

    // realManifest.runtime.appDataMount === true → spawnContainer hace mkdirSync
    // real bajo el volumen del workspace; necesita un hostPath escribible de verdad.
    const tmp = mkdtempSync(join(tmpdir(), 'ws2-whatsapp-'))
    try {
      const { ctx, getOrStartMock } = makeCtx({
        workspaceVolumeHostPath: tmp,
        secrets: {
          WAHA_API_KEY: 'fake-waha-key',
          WHATSAPP_PROXY_SERVER_USERNAME: 'brd-customer-fake-zone-fake',
          WHATSAPP_PROXY_SERVER_PASSWORD: 'fake-proxy-pw',
        },
      })

      await spawnContainer(
        ctx,
        APP_ID,
        makeApp({ mcaId: 'mca.whatsapp', name: 'whatsapp' }),
        makeMca({ mcaId: 'mca.whatsapp', runtime: realManifest.runtime }),
        0,
      )

      // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
      const env = (getOrStartMock.mock.calls[0][1] as any).environment
      expect(env.WAHA_API_KEY).toBe('fake-waha-key')
      expect(env.WHATSAPP_PROXY_SERVER_PASSWORD).toBe('fake-proxy-pw')
      // Sin sufijo -session-${MCA_APP_ID}: la zona Bright Data es res_static y rechaza
      // el username con sufijo (407) — commit 15e4b48c9. El username pasa tal cual.
      expect(env.WHATSAPP_PROXY_SERVER_USERNAME).toBe('brd-customer-fake-zone-fake')
      // Config no-secreta del manifest intacta.
      expect(env.WHATSAPP_DEFAULT_ENGINE).toBe('GOWS')
      expect(env.WAHA_LOCAL_STORE_BASE_DIR).toBe('/app-data')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('dockerNetworks por tier de acceso: MCA interno → workspace+internal, egress → workspace+egress, no listado → solo workspace', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    await spawnContainer(ctx, APP_ID, makeApp({ mcaId: 'mca.teros.feedback' }), makeMca({ mcaId: 'mca.teros.feedback' }), 0)
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const opts1 = (getOrStartMock.mock.calls[0][1] as any)
    expect(opts1.dockerNetworks).toEqual(expect.arrayContaining(['teros_teros-network']))
    expect(opts1.dockerNetworks[0]).toMatch(/^teros_ws_/) // workspace network is first

    // mca.teros.bash (mcaId por defecto en makeApp) está en MCAS_WITH_EGRESS → red de egress dedicada.
    const { ctx: ctx2, getOrStartMock: g2 } = makeCtx()
    await spawnContainer(ctx2, APP_ID, makeApp(), makeMca(), 0)
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const opts2 = (g2.mock.calls[0][1] as any)
    expect(opts2.dockerNetworks).toEqual(expect.arrayContaining(['teros_egress']))
    expect(opts2.dockerNetworks[0]).toMatch(/^teros_ws_/) // workspace network is first

    // Un MCA que no está en ninguna lista → solo red de workspace.
    const { ctx: ctx3, getOrStartMock: g3 } = makeCtx()
    await spawnContainer(ctx3, APP_ID, makeApp({ mcaId: 'mca.slack' }), makeMca({ mcaId: 'mca.slack' }), 0)
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const opts3 = (g3.mock.calls[0][1] as any)
    expect(opts3.dockerNetworks).toHaveLength(1)
    expect(opts3.dockerNetworks[0]).toMatch(/^teros_ws_/)
  })

  it('containerMode per-app → containerKey = appId y mode propagado', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    const managed = await spawnContainer(
      ctx, APP_ID, makeApp(), makeMca({ runtime: { transport: 'http', containerMode: 'per-app' } }), 0,
    )
    expect(managed.containerKey).toBe(APP_ID)
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    expect((getOrStartMock.mock.calls[0][1] as any).containerMode).toBe('per-app')
  })

  it('montaje workspace persistido se pasa solo si el manifest lo declara', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    // biome-ignore lint/suspicious/noExplicitAny: fixture con volumes
    const app = makeApp({ volumes: [{ volumeId: 'vol_work_1', mountPath: '/workspace' }] as any })

    await spawnContainer(
      ctx, APP_ID, app, makeMca({ runtime: { transport: 'http', workspaceMount: true } }), 0,
    )

    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    expect((getOrStartMock.mock.calls[0][1] as any).volumes).toEqual([
      { hostPath: '/srv/volumes/vol_work_1', containerPath: '/workspace', readOnly: false },
    ])
  })

  it('ignora mounts workspace heredados cuando el manifest no requiere acceso local', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    // biome-ignore lint/suspicious/noExplicitAny: fixture con volumes legacy
    const app = makeApp({ volumes: [{ volumeId: 'vol_work_1', mountPath: '/workspace' }] as any })

    await spawnContainer(ctx, APP_ID, app, makeMca(), 0)

    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    expect((getOrStartMock.mock.calls[0][1] as any).volumes).toEqual([])
  })

  it('getOrStart falla → managed queda error con lastError y se propaga', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    getOrStartMock.mockImplementation(async () => {
      throw new Error('no ports')
    })

    await expect(spawnContainer(ctx, APP_ID, makeApp(), makeMca(), 2)).rejects.toThrow('no ports')

    const managed = ctx.mcas.get(APP_ID)
    expect(managed?.status).toBe('error')
    expect(managed?.lastError).toBe('no ports')
    expect(managed?.restartCount).toBe(2)
  })

  it('appDataMount monta /app-data persistente bajo el volumen del workspace', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ter471-'))
    try {
      const { ctx, getOrStartMock } = makeCtx({ workspaceVolumeHostPath: tmp })
      await spawnContainer(
        ctx, APP_ID, makeApp({ name: 'whatsapp' }),
        makeMca({ runtime: { transport: 'http', appDataMount: true } }), 0,
      )
      // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
      const volumes = (getOrStartMock.mock.calls[0][1] as any).volumes
      expect(volumes).toContainEqual({
        hostPath: `${tmp}/.apps/whatsapp`,
        containerPath: '/app-data',
        readOnly: false,
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('systemVolumes del manifest (p.ej. docker socket) se añaden a los mounts', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    await spawnContainer(
      ctx, APP_ID, makeApp(),
      makeMca({
        runtime: {
          transport: 'http',
          systemVolumes: [{ hostPath: '/var/run/docker.sock', containerPath: '/var/run/docker.sock', readOnly: true }],
        },
      }),
      0,
    )
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    expect((getOrStartMock.mock.calls[0][1] as any).volumes).toContainEqual({
      hostPath: '/var/run/docker.sock',
      containerPath: '/var/run/docker.sock',
      readOnly: true,
    })
  })

  it('systemVolume SIN readOnly declarado defaultea a RW (gap S14)', async () => {
    const { ctx, getOrStartMock } = makeCtx()
    await spawnContainer(
      ctx, APP_ID, makeApp(),
      makeMca({
        runtime: {
          transport: 'http',
          systemVolumes: [{ hostPath: '/srv/shared', containerPath: '/shared' }],
        },
      }),
      0,
    )
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    expect((getOrStartMock.mock.calls[0][1] as any).volumes).toContainEqual({
      hostPath: '/srv/shared',
      containerPath: '/shared',
      readOnly: false,
    })
  })

  it('injecta SECRET_MCA_* en environment del contenedor HTTP (regression TER-xxx)', async () => {
    const { ctx, getOrStartMock } = makeCtx({
      secrets: { api_key: 'K1', feedback_api_token: 'FB_TOK', vacio: null },
    })
    await spawnContainer(
      ctx,
      APP_ID,
      makeApp({ mcaId: 'mca.teros.feedback' }),
      makeMca({ mcaId: 'mca.teros.feedback' }),
      0,
    )
    // biome-ignore lint/suspicious/noExplicitAny: shape verificado por asserts
    const env = (getOrStartMock.mock.calls[0][1] as any).environment
    expect(env.SECRET_MCA_API_KEY).toBe('K1')
    expect(env.SECRET_MCA_FEEDBACK_API_TOKEN).toBe('FB_TOK')
    expect('SECRET_MCA_VACIO' in env).toBe(false)
  })
})
