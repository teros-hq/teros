/**
 * Integration test — mca.teros.terminal E2E + convivencia con la terminal window
 *
 * Ejercita el cableado COMPLETO con un proceso MCA real (no mocks del MCA):
 *
 *   MCA process (bun, HTTP transport)
 *     ├─ WS /mca?appId&token → McaConnectionManager (bridge del TestServer)
 *     │    └─ admin_request terminal.* → WsRouter → terminal domain → PtyManager
 *     └─ HTTP /tools/call ← McaHttpClient (este test, como hace el backend)
 *
 * Cobertura:
 *   1. Smoke de las 7 tools: create → write/read → wait-for (REPL python3) →
 *      send-key (ctrl-d) → destroy, con list verificando el ciclo de vida.
 *   2. Convivencia: un cliente "UI" (WebSocket /ws autenticado) se suscribe al
 *      MISMO terminalId creado por el MCA y recibe terminal_output en vivo,
 *      escribe en la sesión (terminal.input) y recibe terminal_exit al destroy.
 *   3. Ninguna sesión muere sola: el sweep de ciclo de vida no destruye una
 *      sesión inactiva (duerme; ver tests/unit/terminal-sleep.test.ts).
 *   4. Authz: sesiones de otros workspaces son invisibles/intocables vía tools.
 *
 * PTYs: FALSOS scripted inyectados en el PtyManager REAL (vía el mismo seam
 * _setupAndStore que usan los unit tests). Razón: bajo bun, node-pty muere a
 * los ~15ms de forma intermitente (fd lifecycle de bun con node-pty — bajo
 * node funciona). El PTY es la única pieza fake: todo lo demás (proceso MCA,
 * bridge WS, handlers, manager, pubsub, cliente UI) es código real. El camino
 * con PTYs reales (host + docker) se valida en scripts/smoke-terminal-mca.ts,
 * que corre con node/tsx (ver cabecera de ese script).
 *
 * La firma HMAC de /tools/call se desactiva en el proceso MCA
 * (MCA_REQUIRE_SIGNATURE=false): es auth de transporte backend→MCA, y la
 * autorización real (workspace-sovereign) se ejercita por el bridge WS.
 *
 * SKIP en CI: spawn de proceso MCA + Docker (mismo criterio que mca-large-input).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import { McaHttpClient } from '../../src/services/mca-http-client';
import { PtyManager } from '../../src/services/pty-manager';
import type { McaManager } from '../../src/services/mca-manager';
import {
  createTestServer,
  type TestServerInstance,
  type TestWebSocketClient,
} from '@teros/testing';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Puerto aleatorio por ejecución — un MCA de un run previo (o su TIME_WAIT)
// no debe impedir arrancar este (EADDRINUSE mataría el proceso MCA en silencio).
const MCA_PORT = 13_000 + Math.floor(Math.random() * 900);
const MCA_URL = `http://127.0.0.1:${MCA_PORT}`;
const MCA_ENTRY = new URL('../../../../mcas/mca.teros.terminal/src/index.ts', import.meta.url).pathname;

const OWNER_EMAIL = 'owner@terminal.test';
// MockAuthHandler: email → user:test_<localPart>
const OWNER_ID = 'user:test_owner';
const WORKSPACE_ID = 'work_terminal_test';

// Suffix del appId = últimas 8 chars tras 'app_' — determina el nombre del
// contenedor Docker que ensureContainerRunning busca (mca-teros-bash-<suffix>).
const TERMINAL_APP_ID = 'app_termmca00000001';
const CONTAINER_NAME = `mca-teros-bash-${TERMINAL_APP_ID.replace('app_', '').slice(-8)}`;

const EXEC_CONTEXT = {
  userId: OWNER_ID,
  workspaceId: WORKSPACE_ID,
  appId: TERMINAL_APP_ID,
} as const;

const SKIP_IN_CI = process.env.CI === 'true' || process.env.SKIP_MCA_INTEGRATION === 'true';
const DOCKER_AVAILABLE = (() => {
  if (SKIP_IN_CI) return false;
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fake PTY scripted — reproduce el contrato node-pty que PtyManager usa
// (onData/onExit/write/resize/kill/pid) con un mini-shell con estado:
// echo → output; python3 → REPL con prompt '>>>'; ctrl-d → vuelve a bash.
// ---------------------------------------------------------------------------

interface FakePty {
  pid: number;
  writes: string[];
  killed: boolean;
  emitData(data: string): void;
  emitExit(code?: number): void;
}

function makeScriptedPty(): FakePty {
  const dataListeners: Array<(d: string) => void> = [];
  const exitListeners: Array<(e: { exitCode: number }) => void> = [];
  const state = { mode: 'bash' as 'bash' | 'python', writes: [] as string[], killed: false };
  // Prompts como LÍNEAS COMPLETAS (\r\n final): el buffer del PtyManager es
  // line-buffered y waitFor/read solo ven líneas completas. (python real deja
  // '>>> ' pendiente sin newline — el match llegaría con el siguiente output;
  // el fake lo simplifica para que el flujo del smoke sea determinista.)
  const BASH_PROMPT = 'agent@teros:~$';

  const pty: FakePty = {
    pid: 424242,
    writes: state.writes,
    get killed() {
      return state.killed;
    },
    emitData(data) {
      for (const cb of dataListeners) cb(data);
    },
    emitExit(code = 0) {
      for (const cb of exitListeners) cb({ exitCode: code });
    },
  };

  // Contrato node-pty que consume PtyManager/_setupAndStore:
  ;(pty as any).onData = (cb: (d: string) => void) => dataListeners.push(cb);
  ;(pty as any).onExit = (cb: (e: { exitCode: number }) => void) => exitListeners.push(cb);
  ;(pty as any).resize = () => {};
  ;(pty as any).kill = () => {
    state.killed = true;
    // node-pty emite exit de forma asíncrona
    setTimeout(() => pty.emitExit(0), 0);
  };
  ;(pty as any).write = (data: string) => {
    state.writes.push(data);
    for (const chunk of data.split('\r')) {
      const line = chunk.replace(/\n/g, '');
      if (state.mode === 'python') {
        if (line === '\x04') {
          // EOF del REPL: python termina (exit), vuelve el prompt de bash
          state.mode = 'bash';
          pty.emitData('\r\nexit\r\n' + BASH_PROMPT + '\r\n');
        } else if (line.length > 0) {
          pty.emitData(`${line}\r\nNone\r\n>>>\r\n`);
        }
      } else if (line === 'python3' || line === 'python') {
        state.mode = 'python';
        pty.emitData(`${line}\r\nPython 3.11.2 (fake) [pty-test] on linux\r\nType "help" for more information.\r\n>>>\r\n`);
      } else if (line.startsWith('echo ')) {
        pty.emitData(`${line}\r\n${line.slice(5)}\r\n` + BASH_PROMPT + '\r\n');
      } else if (line.length > 0) {
        pty.emitData(`${line}\r\n` + BASH_PROMPT + '\r\n');
      }
    }
  };

  return pty;
}

/**
 * Sustituye create/createHost del manager por una versión que inyecta PTYs
 * scripted (mismo seam _setupAndStore que los unit tests). Devuelve un registro
 * terminalId → fake para aserciones y empuje manual de output.
 */
function installFakePtyFactory(manager: PtyManager) {
  const fakes = new Map<string, FakePty>();
  const spawnFake = (terminalId: string, containerId: string, ownerWorkspaceId: string | undefined) => {
    if (fakes.has(terminalId)) return; // create() es no-op si existe (contrato real)
    const fake = makeScriptedPty();
    fakes.set(terminalId, fake);
    (manager as any)._setupAndStore(terminalId, fake, containerId, ownerWorkspaceId);
    // bash imprime su prompt al arrancar — el fake también (ejercita el
    // buffering de output desde el primer momento)
    fake.emitData('agent@teros:~$\r\n');
  };
  (manager as any).create = (terminalId: string, containerId: string, _cols: number, _rows: number, owner?: string) =>
    spawnFake(terminalId, containerId, owner);
  (manager as any).createHost = (terminalId: string, _cols: number, _rows: number, owner?: string) =>
    spawnFake(terminalId, 'host', owner);
  return fakes;
}

// ---------------------------------------------------------------------------
// WS helpers (mismo patrón que feedback-handlers.test.ts)
// ---------------------------------------------------------------------------

async function wsAction(client: TestWebSocketClient, action: string, data: Record<string, unknown>): Promise<any> {
  const requestId = `req_${Math.random().toString(36).slice(2, 8)}`;
  client.send({ type: 'request', requestId, action, data });
  const response = await client.waitFor(
    (msg: any) => (msg.type === 'response' || msg.type === 'error') && msg.requestId === requestId,
    8000,
  );
  if (response.type === 'error') {
    throw new Error(`${action} failed: ${response.code} — ${response.error ?? response.message}`);
  }
  return response.data;
}

// ---------------------------------------------------------------------------
// MCA tool-call helper (el test hace de backend: McaHttpClient → /tools/call)
// ---------------------------------------------------------------------------

let mcaHttp: McaHttpClient;

async function callTool(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await mcaHttp.callTool(tool, args, EXEC_CONTEXT as any, { timeout: 45_000 });
  if (!result.success) {
    throw new Error(`tool ${tool} failed: ${JSON.stringify(result.error ?? result)}`);
  }
  const r: any = result.result;
  // Tools answer the model in text and scripts in structuredContent (MCA 1.2.0).
  if (r && typeof r === 'object' && r.structuredContent) return r.structuredContent;
  if (r && typeof r === 'object' && Array.isArray(r.content)) {
    const text = r.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return r;
}

/**
 * Poll terminal-read hasta que el buffer contenga `pattern` (la salida del PTY
 * es asíncrona; un read único puede llegar antes del echo del comando).
 */
async function readUntil(terminalId: string, pattern: string | RegExp, timeoutMs = 15_000): Promise<string> {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const res = await callTool('terminal-read', { terminalId });
    last = res.output ?? '';
    if (re.test(last)) return last;
    await sleep(150);
  }
  throw new Error(`readUntil: pattern ${pattern} not found within ${timeoutMs}ms. Last output:\n${last}`);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('mca.teros.terminal E2E (proceso MCA real + bridge WS + PtyManager real)', () => {
  let server: TestServerInstance;
  let uiClient: TestWebSocketClient;
  let mcaProcess: ReturnType<typeof Bun.spawn> | null = null;
  let ptyManager: PtyManager;
  let fakes: Map<string, FakePty>;

  beforeAll(async () => {
    if (SKIP_IN_CI) {
      console.log('[terminal-mca] Skipping in CI');
      return;
    }

    // ── Docker: ensureContainerRunning (warmup + docker ps por suffix del appId)
    // busca un contenedor con este nombre aunque el PTY sea scripted — lo
    // levantamos para que terminal.create complete su flujo real.
    execSync(`docker rm -f ${CONTAINER_NAME} 2>/dev/null || true`, { stdio: 'ignore' });
    // --entrypoint sleep: la imagen exige /app/mca montado en su entrypoint
    // y saldría al instante (docker ps solo lista contenedores RUNNING).
    execSync(
      `docker run -d --name ${CONTAINER_NAME} --entrypoint sleep ${process.env.TERMINAL_TEST_IMAGE ?? 'teros/mca-runtime-bash:latest'} infinity`,
      { stdio: 'ignore', timeout: 60_000 },
    );

    // ── PtyManager REAL con PTYs scripted (ver cabecera: bun+node-pty es flaky)
    // El proxy pasa TODOS los broadcasts al pubsub real del TestServer — el
    // streaming terminal_output/terminal_exit hacia la UI es código real.
    const pubsubProxy = {
      broadcasts: [] as Array<{ topic: string; event: Record<string, unknown> }>,
      broadcastToTopic(topic: string, event: Record<string, unknown>) {
        this.broadcasts.push({ topic, event });
        server.pubSubService?.broadcastToTopic(topic, event);
      },
    };
    ptyManager = new PtyManager(pubsubProxy as any);
    fakes = installFakePtyFactory(ptyManager);

    // ── Mock de McaManager SOLO para el warmup de terminal.create
    // (bash_bash → el dominio espera { output, isError }; el contenedor real
    // no se levanta aquí porque los PTYs son scripted).
    const mcaManager = {
      executeTool: async (toolName: string) => {
        if (toolName === 'bash_bash') return { output: 'warmup-ok', isError: false };
        return { output: `unknown tool ${toolName}`, isError: true };
      },
    } as unknown as McaManager;

    server = await createTestServer({
      enableNavbarStack: true,
      enableMcaBridge: true,
      ptyManager,
      mcaManager,
      mockResponses: [{ text: 'mock' }],
    });

    // ── Seed: workspace activo + owner + app del MCA terminal (forma de createWorkspaceApp)
    const { db } = server;
    await db.collection('workspaces').insertOne({
      workspaceId: WORKSPACE_ID,
      ownerId: OWNER_ID,
      name: 'Terminal Test Workspace',
      status: 'active',
      members: [{ userId: OWNER_ID, role: 'admin', addedAt: new Date() }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('workspace_members').insertOne({
      workspaceId: WORKSPACE_ID,
      userId: OWNER_ID,
      role: 'admin',
      status: 'active',
    });
    // El gate userService.hasAccess() (accessGranted) aplica a TODA request WS
    // de clientes UI — sin este doc, el handler responde ACCESS_DENIED sin
    // requestId y el cliente se queda esperando la respuesta hasta el timeout.
    // El path MCA (admin_request) no pasa por este gate, por eso solo fallaba
    // la parte de convivencia con la UI.
    await db.collection('users').insertOne({
      userId: OWNER_ID,
      email: OWNER_EMAIL,
      accessGranted: true,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('apps').insertOne({
      appId: TERMINAL_APP_ID,
      mcaId: 'mca.teros.terminal',
      ownerId: WORKSPACE_ID,
      ownerType: 'workspace',
      name: 'terminal',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // admin_request solo deja pasar las actions del manifest (backend.actions,
    // sincronizado a mca_catalog por sync-mcas) — el TestServer no sincroniza.
    await db.collection('mca_catalog').insertOne({ mcaId: 'mca.teros.terminal', backendActions: ['terminal.*'] });

    // ── Spawn del proceso MCA real (HTTP transport + WS bridge al TestServer)
    const token = server.mcaConnectionManager!.registerPendingConnection(
      TERMINAL_APP_ID,
      'mca.teros.terminal',
      WORKSPACE_ID,
    );
    const wsUrl = `ws://127.0.0.1:${server.port}/mca?appId=${TERMINAL_APP_ID}&token=${token}`;
    mcaProcess = Bun.spawn(['bun', 'run', MCA_ENTRY], {
      env: {
        ...process.env,
        PORT: String(MCA_PORT),
        MCA_WS_URL: wsUrl,
        MCA_APP_ID: TERMINAL_APP_ID,
        MCA_REQUIRE_SIGNATURE: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Drain pipes (sin esto, un pipe lleno bloquea el proceso MCA)
    const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
      if (!stream) return;
      const reader = stream.getReader();
      try { while (!(await reader.read()).done) {} } catch { /* proceso terminado */ }
    };
    void drain(mcaProcess.stdout);
    void drain(mcaProcess.stderr);

    // Esperar /health del MCA
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${MCA_URL}/health`);
        if (res.ok) break;
      } catch { /* not ready yet */ }
      await sleep(200);
    }

    mcaHttp = new McaHttpClient({ baseUrl: MCA_URL });

    // ── Cliente "UI" autenticado (la ventana de terminal del usuario)
    uiClient = await server.createClient();
    await uiClient.authenticate(OWNER_EMAIL);
  }, 60_000);

  afterAll(async () => {
    mcaProcess?.kill();
    uiClient?.close();
    await server?.close();
    if (!SKIP_IN_CI) {
      try {
        execSync(`docker rm -f ${CONTAINER_NAME} 2>/dev/null || true`, { stdio: 'ignore' });
      } catch { /* best-effort */ }
    }
  });

  // =========================================================================
  // 1. Smoke E2E de las 7 tools (el flujo del agente)
  // =========================================================================

  it('-health-check: MCA conectado al bridge WS y terminal.list operativo', async () => {
    if (SKIP_IN_CI) return;
    // El WS del MCA conecta lazy en el PRIMER backendAction — y el
    // health-check hace early-return 'degraded' sin conectar cuando
    // isWsConnected() es false. Forzamos la conexión con terminal-list
    // (inofensivo: lista sesiones) y luego el health-check ya ve el WS vivo.
    const deadline = Date.now() + 15_000;
    let connected = false;
    while (Date.now() < deadline) {
      try {
        await callTool('terminal-list');
        connected = true;
        break;
      } catch { /* MCA arrancando o WS aún no conectado */ }
      await sleep(300);
    }
    expect(connected).toBe(true);

    const health = await callTool('-health-check');
    expect(health?.status).toBe('ready'); // sin issues → WS al backend operativo
  }, 20_000);

  it('terminal-create sin app bash (descubrimiento activo) → error claro y accionable (T-001)', async () => {
    if (SKIP_IN_CI) return;

    // Monta un callback HTTP mínimo que emula /mca/callback/:appId/resources/workspaces/:id/apps
    // respondiendo SIN app mca.teros.bash. Con callbackUrl presente, el MCA
    // ejecuta el descubrimiento de verdad y debe fallar ANTES de terminal.create
    // con un mensaje accionable (no el INTERNAL_ERROR genérico de T-001).
    const { createServer } = await import('node:http');
    const fakeCallback = createServer((req, res) => {
      if (req.url?.includes('/resources/workspaces/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ apps: [] })); // workspace sin bash
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve) => fakeCallback.listen(0, '127.0.0.1', resolve));
    const callbackPort = (fakeCallback.address() as { port: number }).port;

    try {
      const result = await mcaHttp.callTool(
        'terminal-create',
        {},
        { ...EXEC_CONTEXT, callbackUrl: `http://127.0.0.1:${callbackPort}/mca/callback/${TERMINAL_APP_ID}` } as any,
        { timeout: 15_000 },
      );

      expect(result.success).toBe(false);
      const message = String(result.error?.message ?? '');
      expect(message).toContain('mca.teros.bash');
      expect(message).toMatch(/requires the Bash app/i);
      // Y NO el error genérico que el catálogo traducía a 'Ocurrió un error inesperado'
      expect(message).not.toMatch(/Container .* not found after warmup/);
    } finally {
      await new Promise((resolve) => fakeCallback.close(resolve));
    }
  }, 20_000);

  it('terminal-create con app bash en estado no-active → mensaje de estado, no "instala Bash" (T-003)', async () => {
    if (SKIP_IN_CI) return;

    // Igual que el test de T-001 pero el callback devuelve una app bash en
    // estado 'error' — el mensaje debe nombrar el estado actual y NO pedir
    // instalar la app (que ya está instalada).
    const { createServer } = await import('node:http');
    const fakeCallback = createServer((req, res) => {
      if (req.url?.includes('/resources/workspaces/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            apps: [
              {
                appId: 'app_bash_error',
                mcaId: 'mca.teros.bash',
                status: 'error',
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve) => fakeCallback.listen(0, '127.0.0.1', resolve));
    const callbackPort = (fakeCallback.address() as { port: number }).port;

    try {
      const result = await mcaHttp.callTool(
        'terminal-create',
        {},
        { ...EXEC_CONTEXT, callbackUrl: `http://127.0.0.1:${callbackPort}/mca/callback/${TERMINAL_APP_ID}` } as any,
        { timeout: 15_000 },
      );

      expect(result.success).toBe(false);
      const message = String(result.error?.message ?? '');
      // Mensaje específico de estado: menciona la app, el estado y pide reintentar
      expect(message).toContain('mca.teros.bash');
      expect(message).toContain('"error"');
      expect(message).toMatch(/installed in this workspace/i);
      expect(message).toMatch(/try again/i);
      // Y NO el mensaje de "instala Bash" (esa app ya está instalada)
      expect(message).not.toMatch(/requires the Bash app .* to be installed/i);
      expect(message).not.toMatch(/Install the Bash app/i);
      // Y NO el INTERNAL_ERROR crudo del backend
      expect(message).not.toMatch(/Container .* not found after warmup/);
    } finally {
      await new Promise((resolve) => fakeCallback.close(resolve));
    }
  }, 20_000);

  it('terminal-create con app bash en standby → pasa el appId para que el backend haga warmup (T-003)', async () => {
    if (SKIP_IN_CI) return;

    // standby es recuperable: el backend fuerza spawn con bash_bash en
    // ensureContainerRunning. El MCA debe pasar el appId de la app bash en
    // standby (no lanzar error ni caer al fallback) para que el warmup ocurra.
    const { createServer } = await import('node:http');
    const standbyAppId = 'app_bash_standby';
    const fakeCallback = createServer((req, res) => {
      if (req.url?.includes('/resources/workspaces/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            apps: [
              {
                appId: standbyAppId,
                mcaId: 'mca.teros.bash',
                status: 'standby',
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve) => fakeCallback.listen(0, '127.0.0.1', resolve));
    const callbackPort = (fakeCallback.address() as { port: number }).port;

    try {
      // El dominio buscará el contenedor mca-teros-bash-<suffix de app_bash_standby>
      // tras el warmup — como no existe en el entorno de test, terminal.create
      // fallará con el error del backend, NO con un mensaje del MCA. Lo que
      // validamos aquí es que el MCA NO lanza su propio error (ni "instala
      // Bash" ni "estado standby") — deja pasar la llamada al backend.
      const result = await mcaHttp.callTool(
        'terminal-create',
        {},
        { ...EXEC_CONTEXT, callbackUrl: `http://127.0.0.1:${callbackPort}/mca/callback/${TERMINAL_APP_ID}` } as any,
        { timeout: 15_000 },
      );

      // Si el MCA hubiera lanzado su propio error, success=false con un mensaje
      // del tipo "requires the Bash app" o "current status is". El error que
      // esperamos aquí es el del backend (container lookup), que prueba que el
      // appId de la app standby llegó hasta terminal.create.
      if (!result.success) {
        const message = String(result.error?.message ?? '');
        expect(message).not.toMatch(/requires the Bash app/i);
        expect(message).not.toMatch(/current status is/i);
      }
      // Si success=true (entornos donde el warmup resuelve un contenedor real),
      // también vale: el punto es que el MCA no bloqueó la llamada.
    } finally {
      await new Promise((resolve) => fakeCallback.close(resolve));
    }
  }, 20_000);

  it('smoke: create → list → write/read → wait-for(REPL) → send-key(ctrl-d) → destroy', async () => {
    if (SKIP_IN_CI) return;

    // ── terminal-create: devuelve terminalId y la sesión aparece en terminal-list
    const created = await callTool('terminal-create', { cols: 100, rows: 30 });
    expect(created.terminalId).toMatch(/^term_/);
    expect(created.status).toBe('ready');
    // Sin callbackUrl HTTP (el test no monta el callback del backend) el MCA no
    // puede descubrir la app mca.teros.bash del workspace → cae al fallback
    // best-effort (su propio appId) y el dominio busca el contenedor por ese
    // sufijo. bashAppResolved=false aquí NO es el camino degenerado de T-001:
    // con descubrimiento disponible y sin bash, terminal-create lanza error
    // claro (ver el test 'sin app bash → error descriptivo' más abajo).
    expect(created.bashAppResolved).toBe(false);
    const terminalId = created.terminalId as string;

    const listed = await callTool('terminal-list');
    const session = (listed.sessions ?? []).find((s: any) => s.terminalId === terminalId);
    expect(session).toBeDefined();
    expect(session.alive).toBe(true);
    expect(session.ownerWorkspaceId).toBe(WORKSPACE_ID);
    expect(session.lifecycle).toBe('awake');

    // ── terminal-write + terminal-read: echo hello → "hello" en el buffer
    await callTool('terminal-write', { terminalId, text: 'echo hello' });
    const readAfterEcho = await readUntil(terminalId, /^hello$/m);
    expect(readAfterEcho).toContain('hello');

    // ── terminal-wait-for: REPL python3 → matchea el prompt >>>
    await callTool('terminal-write', { terminalId, text: 'python3' });
    const wait = await callTool('terminal-wait-for', {
      terminalId,
      pattern: '>>>',
      timeoutMs: 10_000,
    });
    expect(wait.matched).toBe(true);
    expect(wait.output).toContain('>>>'); // la tool expone el texto como 'output'
    expect(wait.cursor).toBeGreaterThan(0);

    // ── terminal-send-key: ctrl-d sale del REPL (EOF) → vuelve el prompt bash
    const key = await callTool('terminal-send-key', { terminalId, key: 'ctrl-d' });
    expect(key.sent).toBe(true);
    expect(key.sequence).toBe('\\x04');
    // El prompt de bash reaparece DESPUÉS del cursor del '>>>'
    const backToBash = await callTool('terminal-wait-for', {
      terminalId,
      pattern: '\\$\\s*$',
      since: wait.cursor,
      timeoutMs: 10_000,
    });
    expect(backToBash.matched).toBe(true);

    // ── terminal-destroy: la sesión desaparece de terminal-list
    const destroyed = await callTool('terminal-destroy', { terminalId });
    expect(destroyed.destroyed).toBe(true);
    await sleep(200);
    const afterDestroy = await callTool('terminal-list');
    expect((afterDestroy.sessions ?? []).find((s: any) => s.terminalId === terminalId)).toBeUndefined();

    // Idempotente: destruir dos veces → alreadyGone (TERMINAL_NOT_FOUND mapeado)
    const again = await callTool('terminal-destroy', { terminalId });
    // Destroy es idempotente: PtyManager.destroy es no-op silencioso para
    // sesiones inexistentes (decisión de diseño del dominio para la UX
    // interactiva), así que el backend responde ok:true y la tool devuelve
    // destroyed:true SIN alreadyGone (esa rama requiere un error del backend
    // que hoy no se emite).
    expect(again.destroyed).toBe(true);
    expect(again.alreadyGone).toBeUndefined();
  }, 45_000);

  // =========================================================================
  // 1b. T-004: wait-for no matchea el eco del propio comando ni líneas viejas
  // =========================================================================

  it('T-004: write+wait-for inmediato espera al output REAL, no al eco del comando', async () => {
    if (SKIP_IN_CI) return;

    const created = await callTool('terminal-create');
    const terminalId = created.terminalId as string;

    // Reproducción del audit: el patrón aparece literalmente en la línea de
    // comando → el fake PTY la re-echa (como un TTY real). Antes del fix el
    // wait-for resolvía al instante contra el eco; ahora debe ignorarlo y
    // matchear solo el output posterior.
    const writeRes = await callTool('terminal-write', { terminalId, text: 'echo AUDIT-WAITFOR-OK' });
    // terminal-write ahora expone el cursor post-write (encadenable con since=)
    expect(typeof writeRes.cursor).toBe('number');

    const wait = await callTool('terminal-wait-for', {
      terminalId,
      pattern: 'AUDIT-WAITFOR-OK',
      timeoutMs: 10_000,
    });
    expect(wait.matched).toBe(true);
    // El match es la línea de OUTPUT ('AUDIT-WAITFOR-OK' a secas), no la línea
    // de eco ('echo AUDIT-WAITFOR-OK') ni el prompt con el comando.
    expect(wait.output).toBe('AUDIT-WAITFOR-OK');
    expect(wait.output).not.toContain('echo');

    await callTool('terminal-destroy', { terminalId });
  }, 30_000);

  it('T-004: wait-for sin since no matchea ocurrencias previas al último write', async () => {
    if (SKIP_IN_CI) return;

    const created = await callTool('terminal-create');
    const terminalId = created.terminalId as string;

    // Primera ocurrencia del patrón (comando + output ya en el buffer):
    await callTool('terminal-write', { terminalId, text: 'echo MARKER' });
    await readUntil(terminalId, /^MARKER$/m);

    // Segundo comando cuyo output NO contiene el patrón: el wait-for que sigue
    // no debe rescatar el 'MARKER' viejo (ni el eco de 'echo MARKER') —
    // espera una ocurrencia NUEVA.
    await callTool('terminal-write', { terminalId, text: 'echo OTHER' });
    const waitPromise = callTool('terminal-wait-for', {
      terminalId,
      pattern: '^MARKER$',
      timeoutMs: 8_000,
    });

    // Deja que el wait-for se registre y el output de 'echo OTHER' llegue;
    // si el bug existiera, ya habría resuelto contra el buffer viejo.
    await sleep(500);
    await callTool('terminal-write', { terminalId, text: 'echo MARKER' });

    const wait = await waitPromise;
    expect(wait.matched).toBe(true);
    expect(wait.output).toBe('MARKER');
    // El match es POSTERIOR al segundo write (índice de línea nuevo, no el viejo)
    expect(wait.lineIndex).toBeGreaterThan(0);

    await callTool('terminal-destroy', { terminalId });
  }, 30_000);

  // =========================================================================
  // 2. Convivencia: la ventana de terminal de la UI ve la sesión del MCA
  // =========================================================================

  it('convivencia: la UI se suscribe al terminalId del MCA, ve output en vivo, escribe y recibe terminal_exit', async () => {
    if (SKIP_IN_CI) return;

    const created = await callTool('terminal-create');
    const terminalId = created.terminalId as string;

    // La UI se suscribe a la MISMA sesión (mismo terminalId — así abre la
    // ventana TerminalWindow el frontend).
    const sub = await wsAction(uiClient, 'terminal.subscribe', { terminalId });
    expect(sub.terminalId).toBe(terminalId);
    expect(sub.topic).toBe(`terminal:${terminalId}`);

    // El MCA escribe → la UI recibe el output EN VIVO (streaming, sin read)
    const outputPromise = uiClient.waitFor(
      (msg: any) => msg.type === 'terminal_output' && msg.terminalId === terminalId && String(msg.data ?? '').includes('UI_SEES_THIS'),
      10_000,
    );
    await callTool('terminal-write', { terminalId, text: 'echo UI_SEES_THIS' });
    const output = await outputPromise;
    expect(output.terminalId).toBe(terminalId);
    expect(output.data).toContain('UI_SEES_THIS');

    // La UI escribe (terminal.input = keystrokes del usuario) → el buffer del
    // MCA refleja el efecto del comando tecleado por la UI.
    await wsAction(uiClient, 'terminal.input', { terminalId, data: 'echo FROM_UI\r' });
    const mcaView = await readUntil(terminalId, /FROM_UI/);
    expect(mcaView).toContain('FROM_UI');

    // El MCA destruye → la UI recibe terminal_exit
    const exitPromise = uiClient.waitFor(
      (msg: any) => msg.type === 'terminal_exit' && msg.terminalId === terminalId,
      10_000,
    );
    await callTool('terminal-destroy', { terminalId });
    const exit = await exitPromise;
    expect(exit.terminalId).toBe(terminalId);
    expect(exit.exitCode).toBe(0);
  }, 30_000);

  it('convivencia: terminal.read de la UI (cursor) y terminal.status comparten el buffer del MCA', async () => {
    if (SKIP_IN_CI) return;

    const created = await callTool('terminal-create');
    const terminalId = created.terminalId as string;
    await callTool('terminal-write', { terminalId, text: 'echo SHARED_BUFFER' });
    await readUntil(terminalId, /SHARED_BUFFER/);

    // La UI lee el MISMO buffer vía WS (terminal.read) — mismo terminalId.
    const uiRead = await wsAction(uiClient, 'terminal.read', { terminalId });
    expect(uiRead.output).toContain('SHARED_BUFFER');
    expect(uiRead.cursor).toBeGreaterThan(0);

    // terminal.status (introspección que la UI puede usar al reconectar)
    const status = await wsAction(uiClient, 'terminal.status', { terminalId });
    expect(status.status.terminalId).toBe(terminalId);
    expect(status.status.alive).toBe(true);
    expect(status.status.ownerWorkspaceId).toBe(WORKSPACE_ID);
    expect(status.status.lifecycle).toBe('awake');

    // Read incremental con cursor: solo output nuevo
    await callTool('terminal-write', { terminalId, text: 'echo SECOND_LINE' });
    await readUntil(terminalId, /SECOND_LINE/);
    const incremental = await wsAction(uiClient, 'terminal.read', {
      terminalId,
      since: uiRead.cursor,
    });
    expect(incremental.output).toContain('SECOND_LINE');
    expect(incremental.output).not.toContain('SHARED_BUFFER');

    await callTool('terminal-destroy', { terminalId });
  }, 30_000);

  // =========================================================================
  // 3. Ninguna sesión muere sola (duermen; el detalle en terminal-sleep.test.ts)
  // =========================================================================

  it('lifecycle: el sweep nunca destruye una sesión inactiva (sin terminal_exit)', async () => {
    if (SKIP_IN_CI) return;

    const events: Array<Record<string, unknown>> = [];
    const idle = new PtyManager({
      broadcastToTopic: (topic: string, event: Record<string, unknown>) => events.push(event),
    } as any, { freezeAfterMs: 300 });
    installFakePtyFactory(idle);
    const terminalId = `term_idle_${Date.now().toString(36)}`;
    idle.createHost(terminalId, 80, 24, WORKSPACE_ID);

    await sleep(400);
    (idle as any)._lifecycleSweep(Date.now() + 24 * 3600_000);
    await sleep(50);
    expect(events.find((e) => e.type === 'terminal_exit')).toBeUndefined();
    expect(idle.has(terminalId)).toBe(true);
    expect(idle.list().find((s) => s.terminalId === terminalId)!.lifecycle).toBe('awake');
  }, 15_000);

  // =========================================================================
  // 4. Authz del bridge: el workspace manda (el MCA no puede tocar sesiones ajenas)
  // =========================================================================

  it('authz: una sesión de OTRO workspace es invisible e intocable vía las tools del MCA', async () => {
    if (SKIP_IN_CI) return;

    const foreignId = `term_foreign_${Date.now().toString(36)}`;
    ptyManager.createHost(foreignId, 80, 24, 'work_other_workspace');

    const listed = await callTool('terminal-list');
    expect((listed.sessions ?? []).find((s: any) => s.terminalId === foreignId)).toBeUndefined();

    let err: any;
    try {
      await callTool('terminal-read', { terminalId: foreignId });
    } catch (e) {
      err = e;
    }
    // El bridge propaga el userMessage del WsRouter; el código viaja en .code
    expect(String(err?.message ?? err)).toMatch(/FORBIDDEN_TERMINAL|No access to terminal/i);

    ptyManager.destroy(foreignId);
  }, 15_000);
});
