/**
 * @todo nira - 2026-10-19: OBSOLETE — este smoke valida el modo host-PTY, que se
 * eliminó con mca.teros.admin.bash el 2026-10-19 (reemplazado por Teros Remote).
 * Ya no corre: terminal.create no tiene rama createHost. Reescribir para modo
 * contenedor o borrar. Se conserva solo como referencia.
 *
 * Smoke test E2E del MCA mca.teros.terminal con PTY REAL (node-pty).
 *
 * ¿Por qué un script aparte si existe tests/integration/terminal-mca.test.ts?
 * La suite de integración corre bajo bun, y bun + node-pty es inestable: los
 * PTYs de host mueren a los ~15-20ms (bug de ciclo de vida de fds bajo bun).
 * Este script corre bajo node/tsx, donde node-pty es estable, y valida el
 * flujo completo contra PTYs reales de /bin/bash (modo host, sin Docker):
 *
 *   1. El proceso MCA real se conecta al bridge WS del backend
 *   2. Un host PTY es solo para un system admin en su propia sesión: el agente
 *      (bridge, ctx del owner) NO puede abrirlo, ni leerlo, ni verlo en la lista
 *   3. La UI del system admin (TERMINAL_HOST_PTY=1): create → write → read →
 *      python3 → waitFor('>>>') → ctrl-d → output en vivo → destroy
 *
 * Uso:  npx tsx scripts/smoke-terminal-mca.ts
 * Requiere: MongoDB local (packages/backend/.env.test) y python3 en el host.
 */

import { spawn } from 'node:child_process';
import { config as dotenvConfig } from 'dotenv';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
dotenvConfig({ path: join(ROOT, 'packages', 'backend', '.env.test') });
// El dominio terminal lee el kill switch al registrarse (createTestServer).
process.env.TERMINAL_HOST_PTY = '1';
// Un "secreto" en el env del backend que el host PTY no debe heredar.
process.env.SMOKE_BACKEND_SECRET = 'must-not-leak';

import { createTestServer, type TestServerInstance, type TestWebSocketClient } from '@teros/testing';
import { PtyManager } from '../packages/backend/src/services/pty-manager';
import { McaHttpClient } from '../packages/backend/src/services/mca-http-client';
import type { McaManager } from '../packages/backend/src/services/mca-manager';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MCA_PORT = 13_100 + Math.floor(Math.random() * 800);
const MCA_URL = `http://127.0.0.1:${MCA_PORT}`;
const MCA_ENTRY = join(ROOT, 'mcas', 'mca.teros.terminal', 'src', 'index.ts');

const OWNER_EMAIL = 'owner@terminal-smoke.test';
const OWNER_ID = 'user:test_owner'; // MockAuthHandler: email → user:test_<localPart>
const WORKSPACE_ID = 'work_terminal_smoke';
const TERMINAL_APP_ID = 'app_termmcasmoke0001';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function step(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mcaHttp: McaHttpClient;

// Contexto de ejecución que el MCA SDK exige en /tools/call (la authz real
// ocurre en el backend vía el bridge WS, no aquí).
const EXEC_CONTEXT = {
  userId: OWNER_ID,
  workspaceId: WORKSPACE_ID,
  appId: TERMINAL_APP_ID,
} as const;

/** Llama a una tool del MCA vía HTTP y parsea el content JSON. */
async function callTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await mcaHttp.callTool(name, args, EXEC_CONTEXT as any, { timeout: 45_000 });
  if (!result.success) {
    throw new Error(`tool ${name} failed: ${JSON.stringify(result.error ?? result)}`);
  }
  const r: any = result.result;
  // MCA 1.2.0: text for the model, the data as structuredContent.
  if (r && typeof r === 'object' && r.structuredContent) return r.structuredContent as T;
  if (r && typeof r === 'object' && Array.isArray(r.content)) {
    const text = r.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
  return r as T;
}

/** Request WS estilo UI contra el TestServer. */
async function wsAction(client: TestWebSocketClient, action: string, data: unknown): Promise<any> {
  const requestId = `req_${Math.random().toString(36).slice(2)}`;
  client.send({ type: 'request', requestId, action, data });
  const response = await client.waitFor(
    (msg: any) =>
      (msg.type === 'response' || msg.type === 'error') && msg.requestId === requestId,
    10_000,
  );
  if (response.type === 'error') {
    throw new Error(`${action} failed: ${response.code} — ${response.error ?? response.message}`);
  }
  return response.data; // el envelope del WsRouter envuelve el resultado en data
}

/** Lee del terminal (vía la UI) hasta que el buffer contiene el patrón (con reintentos). */
async function readUntil(client: TestWebSocketClient, terminalId: string, re: RegExp, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const r = await wsAction(client, 'terminal.read', { terminalId });
    last = String(r.output ?? '');
    if (re.test(last)) return last;
    await sleep(250);
  }
  throw new Error(`readUntil: patrón ${re} no apareció. Último output: ${JSON.stringify(last.slice(-400))}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Smoke E2E mca.teros.terminal (PTY real, modo host, sin Docker) ===\n');

  // ── PtyManager REAL: bajo node, node-pty es estable (bajo bun muere a ~15ms)
  const ptyManager = new PtyManager({
    broadcastToTopic(topic: string, event: Record<string, unknown>) {
      server.pubSubService?.broadcastToTopic(topic, event);
    },
  } as any);

  // Mock de McaManager solo para el warmup de terminal.create (no se llega a
  // usar en modo host, pero el dominio lo exige en su constructor).
  const mcaManager = {
    executeTool: async (toolName: string) => ({ output: `mock ${toolName}`, isError: false }),
  } as unknown as McaManager;

  let server: TestServerInstance | undefined;
  let uiClient: TestWebSocketClient | undefined;
  let mcaProcess: ReturnType<typeof spawn> | undefined;

  try {
    server = await createTestServer({
      enableNavbarStack: true,
      enableMcaBridge: true,
      ptyManager,
      mcaManager,
      mockResponses: [{ text: 'mock' }],
    });
    console.log(`TestServer en :${server.port} (mongo: ${server.db.databaseName})`);

    // ── Seed: workspace + owner system admin (accessGranted) + app con mcaId
    // admin.bash → terminal.create entra en modo HOST (createHost, /bin/bash
    // real) solo para la sesión UI del admin, nunca vía el bridge del MCA.
    const { db } = server;
    await db.collection('workspaces').insertOne({
      workspaceId: WORKSPACE_ID,
      ownerId: OWNER_ID,
      name: 'Terminal Smoke Workspace',
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
    await db.collection('users').insertOne({
      userId: OWNER_ID,
      email: OWNER_EMAIL,
      role: 'admin',
      accessGranted: true,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('apps').insertOne({
      appId: TERMINAL_APP_ID,
      mcaId: 'mca.teros.admin.bash', // ← activa el modo host en terminal.create
      ownerId: WORKSPACE_ID,
      ownerType: 'workspace',
      name: 'terminal-smoke',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // admin_request solo deja pasar las actions del manifest (backend.actions,
    // sincronizado a mca_catalog por sync-mcas) — el TestServer no sincroniza.
    await db.collection('mca_catalog').insertOne({ mcaId: 'mca.teros.terminal', backendActions: ['terminal.*'] });

    // ── Spawn del proceso MCA real + bridge WS
    const token = server.mcaConnectionManager!.registerPendingConnection(
      TERMINAL_APP_ID,
      'mca.teros.terminal',
      WORKSPACE_ID,
    );
    const wsUrl = `ws://127.0.0.1:${server.port}/mca?appId=${TERMINAL_APP_ID}&token=${token}`;
    mcaProcess = spawn('bun', ['run', MCA_ENTRY], {
      env: {
        ...process.env,
        PORT: String(MCA_PORT),
        MCA_WS_URL: wsUrl,
        MCA_APP_ID: TERMINAL_APP_ID,
        MCA_REQUIRE_SIGNATURE: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mcaProcess.stdout!.on('data', () => {}); // drenar: sin esto el proceso se bloquea
    mcaProcess.stderr!.on('data', () => {});

    // Esperar a que el HTTP del MCA responda
    let mcaUp = false;
    for (let i = 0; i < 50 && !mcaUp; i++) {
      try {
        const res = await fetch(`${MCA_URL}/health`);
        if (res.ok) mcaUp = true;
      } catch { /* arrancando */ }
      if (!mcaUp) await sleep(200);
    }
    step('MCA process arrancado (HTTP health OK)', mcaUp);
    if (!mcaUp) throw new Error('el proceso MCA no arrancó');

    mcaHttp = new McaHttpClient({ baseUrl: MCA_URL });

    // El WS del MCA conecta lazy en el primer backendAction — forzarlo con
    // terminal-list (el health-check no conecta: early-return 'degraded').
    let bridgeUp = false;
    for (let i = 0; i < 50 && !bridgeUp; i++) {
      try {
        await callTool('terminal-list');
        bridgeUp = true;
      } catch { /* WS aún no conectado */ }
      if (!bridgeUp) await sleep(300);
    }
    step('Bridge WS MCA↔backend operativo (terminal-list OK)', bridgeUp);
    if (!bridgeUp) throw new Error('el MCA no conectó al bridge WS');

    const health = await callTool('-health-check');
    step('health-check ready', health?.status === 'ready', `status=${health?.status}`);

    // Cliente "UI" autenticado (la ventana de terminal del usuario)
    uiClient = await server.createClient();
    await uiClient.authenticate(OWNER_EMAIL);

    // =======================================================================
    // 1. El agente (bridge MCA) no obtiene un shell en el host
    // =======================================================================

    let agentErr: unknown;
    try {
      await callTool('terminal-create');
    } catch (e) {
      agentErr = e;
    }
    // El MCA re-envuelve el código (INTERNAL_ERROR); el mensaje es el del gate.
    step('agente: terminal-create sobre admin.bash rechazado', /FORBIDDEN|Admin privileges required/.test(String(agentErr)), String(agentErr).slice(0, 120));

    // =======================================================================
    // 2. Flujo de la UI del system admin: host PTY real
    // =======================================================================

    const terminalId = `term_smoke_${Date.now().toString(36)}`;
    const created = await wsAction(uiClient, 'terminal.create', { terminalId, appId: TERMINAL_APP_ID, mcaId: 'mca.teros.admin.bash' });
    step('UI terminal.create (host)', created?.host === true, `id=${terminalId} host=${created?.host}`);

    const agentList = await callTool('terminal-list');
    step('agente: terminal-list no muestra el host PTY',
      !(agentList.sessions ?? []).some((s: any) => s.terminalId === terminalId));

    let readErr: unknown;
    try {
      await callTool('terminal-read', { terminalId });
    } catch (e) {
      readErr = e;
    }
    step('agente: terminal-read del host PTY rechazado', /FORBIDDEN_TERMINAL|No access to terminal/i.test(String(readErr)));

    await wsAction(uiClient, 'terminal.write', { terminalId, data: 'echo SMOKE_$((40+2))', sendEnter: true });
    const out1 = await readUntil(uiClient, terminalId, /SMOKE_42/);
    step('write + read: echo ejecutado', out1.includes('SMOKE_42'));

    await wsAction(uiClient, 'terminal.write', { terminalId, data: 'echo "ENV_${SMOKE_BACKEND_SECRET:-scrubbed}"', sendEnter: true });
    const envOut = await readUntil(uiClient, terminalId, /^ENV_/m);
    step('host PTY sin secretos del backend en el env', /^ENV_scrubbed\s*$/m.test(envOut));

    await wsAction(uiClient, 'terminal.write', { terminalId, data: 'python3', sendEnter: true });
    const wait = await wsAction(uiClient, 'terminal.waitFor', { terminalId, pattern: '>>>', timeoutMs: 10_000 });
    step('waitFor: REPL de python (>>>)', wait?.matched === true, `line=${JSON.stringify(String(wait?.line ?? '').slice(-60))}`);

    await wsAction(uiClient, 'terminal.write', { terminalId, data: "print('REPL_OK')", sendEnter: true });
    await readUntil(uiClient, terminalId, /REPL_OK/);
    await wsAction(uiClient, 'terminal.input', { terminalId, data: '\x04' });
    // Salida del REPL verificada semánticamente: si ctrl-d devolvió el control
    // a bash, `echo $((6*7))` produce una línea propia '42'; si siguiéramos en
    // python daría SyntaxError y nunca aparecería. No se matchea el prompt
    // porque varía por máquina (aquí es '[user@host:cwd] ⚡', no '$ ').
    await wsAction(uiClient, 'terminal.write', { terminalId, data: 'echo $((6*7))', sendEnter: true });
    const backOut = await readUntil(uiClient, terminalId, /^42$/m);
    step('ctrl-d: salida del REPL (bash evalúa de nuevo)', /^42$/m.test(backOut));

    const outputPromise = uiClient.waitFor(
      (msg: any) =>
        msg.type === 'terminal_output' &&
        msg.terminalId === terminalId &&
        String(msg.data ?? '').includes('UI_SEES_THIS'),
      10_000,
    );
    await wsAction(uiClient, 'terminal.input', { terminalId, data: 'echo UI_SEES_THIS\r' });
    const live = await outputPromise;
    step('UI recibe terminal_output en vivo', String(live.data).includes('UI_SEES_THIS'));

    // terminal.destroy desuscribe a quien lo llama antes de que llegue el
    // terminal_exit del PTY: se verifica que la sesión desaparece.
    await wsAction(uiClient, 'terminal.destroy', { terminalId });
    const afterDestroy = await wsAction(uiClient, 'terminal.list', {});
    step('UI destruye → la sesión desaparece',
      !(afterDestroy.sessions ?? []).some((s: any) => s.terminalId === terminalId));

    // =======================================================================
    // Resultado
    // =======================================================================

    console.log(`\n=== Resultado: ${passed} OK, ${failed} FALLOS ===`);
    // Salida explícita: el event loop queda vivo (mongoClient del TestServer,
    // handles internos) y el proceso colgaría hasta el timeout del shell.
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    console.error(`\n💥 Error fatal: ${error instanceof Error ? error.stack : error}`);
    process.exitCode = 1;
  } finally {
    mcaProcess?.kill();
    uiClient?.close();
    await server?.close();
  }
}

main();
