/**
 * Smoke E2E del fix T-005 (audit 2026-10-18): terminal-create con cwd.
 *
 * Cubre el contrato nuevo de cwdApplied/cwdError/startCursor con el proceso
 * MCA real corriendo mcas/mca.teros.terminal/src/index.ts contra el bridge
 * WS → dominio terminal del backend en modo DOCKER (el path real de
 * producción, no el modo host — que rechaza llamadas del bridge):
 *
 *   1. cwd válido (/tmp)   → cwdApplied: true, cwdError: null, pwd == /tmp
 *   2. cwd inexistente     → cwdApplied: false, cwdError con el error del shell
 *   3. sin cwd             → cwdApplied: false, cwdError: null, cwd: null
 *
 * Cómo se monta el escenario (mismo patrón que tests/integration/terminal-mca.test.ts):
 *   - Se levanta un contenedor Docker real (`sleep infinity`) con el nombre
 *     que ensureContainerRunning busca (mca-teros-bash-<suffix del appId>).
 *   - PtyManager.create se sustituye por una versión que spawna /bin/bash
 *     local con node-pty (bajo node/tsx es estable; bajo bun muere a ~15ms).
 *     El shell es real: cd/pwd/errores se comportan igual que en el contenedor.
 *   - Todo lo demás — proceso MCA, bridge WS, handlers, waitFor/read — es
 *     código de producción real.
 *
 * Uso:  npx tsx scripts/smoke-terminal-cwd.mts
 * Requiere: Docker y MongoDB local (packages/backend/.env.test), bash en el host.
 */

import { spawn, execSync } from 'node:child_process';
import { config as dotenvConfig } from 'dotenv';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
dotenvConfig({ path: join(ROOT, 'packages', 'backend', '.env.test') });

import { createTestServer, type TestServerInstance } from '@teros/testing';
import { PtyManager } from '../packages/backend/src/services/pty-manager';
import { McaHttpClient } from '../packages/backend/src/services/mca-http-client';
import type { McaManager } from '../packages/backend/src/services/mca-manager';
import pty from 'node-pty';

const MCA_PORT = 14_100 + Math.floor(Math.random() * 800);
const MCA_URL = `http://127.0.0.1:${MCA_PORT}`;
const MCA_ENTRY = join(ROOT, 'mcas', 'mca.teros.terminal', 'src', 'index.ts');

const OWNER_EMAIL = 'owner@cwd-smoke.test';
const OWNER_ID = 'user:test_owner';
const WORKSPACE_ID = 'work_cwd_smoke';
// ensureContainerRunning busca mca-teros-bash-<últimos 8 chars del appId>
const TERMINAL_APP_ID = 'app_cwdsmk0smoke001';
const CONTAINER_NAME = 'mca-teros-bash-smoke001';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function step(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Sustituye create() por un spawn de bash local (mismo seam que los tests). */
function patchPtyManagerCreate(manager: PtyManager): void {
  (manager as any).create = (terminalId: string, containerId: string, cols: number, rows: number, owner?: string) => {
    if ((manager as any).sessions.has(terminalId)) return; // contrato real: no-op si existe
    const ptyProcess = pty.spawn('/bin/bash', ['--norc', '-i'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: '/',
      env: { TERM: 'xterm-256color', PS1: '$ ' } as any,
    });
    (manager as any)._setupAndStore(terminalId, ptyProcess, containerId, owner);
  };
}

let mcaHttp: McaHttpClient;

const EXEC_CONTEXT = {
  userId: OWNER_ID,
  workspaceId: WORKSPACE_ID,
  appId: TERMINAL_APP_ID,
} as const;

async function callTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await mcaHttp.callTool(name, args, EXEC_CONTEXT as any, { timeout: 45_000 });
  if (!result.success) {
    throw new Error(`tool ${name} failed: ${JSON.stringify(result.error ?? result)}`);
  }
  const r: any = result.result;
  // MCA 1.2.0: text for the model, the data as structuredContent.
  if (r && typeof r === 'object' && r.structuredContent) return r.structuredContent as T;
  // Respuesta directa (sin envelope MCP content): devolverla tal cual.
  if (r && typeof r === 'object' && !Array.isArray(r.content) && r.terminalId !== undefined) return r as T;
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

async function main(): Promise<void> {
  console.log('=== Smoke E2E T-005: terminal-create cwd semantics ===\n');

  // Contenedor real para que `docker ps` de ensureContainerRunning lo encuentre.
  // --entrypoint sleep: la imagen exige /app/mca montado y saldría al instante.
  execSync(`docker rm -f ${CONTAINER_NAME} 2>/dev/null || true`, { stdio: 'ignore' });
  execSync(
    `docker run -d --name ${CONTAINER_NAME} --entrypoint sleep ${process.env.TERMINAL_TEST_IMAGE ?? "teros/mca-runtime-bash:latest"} infinity`,
    { stdio: 'ignore', timeout: 60_000 },
  );

  const ptyManager = new PtyManager({
    broadcastToTopic(topic: string, event: Record<string, unknown>) {
      server.pubSubService?.broadcastToTopic(topic, event);
    },
  } as any);
  patchPtyManagerCreate(ptyManager);

  const mcaManager = {
    executeTool: async (toolName: string) => ({ output: `mock ${toolName}`, isError: false }),
  } as unknown as McaManager;

  let server: TestServerInstance | undefined;
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

    const { db } = server;
    await db.collection('workspaces').insertOne({
      workspaceId: WORKSPACE_ID,
      ownerId: OWNER_ID,
      name: 'cwd smoke',
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
    // mcaId 'mca.teros.bash' → rama Docker de terminal.create (no el gate de
    // host, que rechaza llamadas del bridge).
    await db.collection('apps').insertOne({
      appId: TERMINAL_APP_ID,
      mcaId: 'mca.teros.bash',
      ownerId: WORKSPACE_ID,
      ownerType: 'workspace',
      name: 'cwd-smoke',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('mca_catalog').insertOne({ mcaId: 'mca.teros.terminal', backendActions: ['terminal.*'] });

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
    mcaProcess.stdout!.on('data', () => {});
    mcaProcess.stderr!.on('data', () => {});

    let mcaUp = false;
    for (let i = 0; i < 50 && !mcaUp; i++) {
      try {
        const res = await fetch(`${MCA_URL}/health`);
        if (res.ok) mcaUp = true;
      } catch { /* arrancando */ }
      if (!mcaUp) await sleep(200);
    }
    if (!mcaUp) throw new Error('el proceso MCA no arrancó');

    mcaHttp = new McaHttpClient({ baseUrl: MCA_URL });

    let bridgeUp = false;
    for (let i = 0; i < 50 && !bridgeUp; i++) {
      try {
        await callTool('terminal-list');
        bridgeUp = true;
      } catch { /* WS aún no conectado */ }
      if (!bridgeUp) await sleep(300);
    }
    if (!bridgeUp) throw new Error('el MCA no conectó al bridge WS');
    step('MCA + bridge operativos', true);

    // ======================================================================
    // 1. cwd válido → cwdApplied: true, pwd correcto
    // ======================================================================
    const ok: any = await callTool('terminal-create', { cwd: '/tmp' });
    step('cwd válido: cwdApplied === true', ok.cwdApplied === true, JSON.stringify({ cwdApplied: ok.cwdApplied, cwdError: ok.cwdError }));
    step('cwd válido: cwdError === null', ok.cwdError === null);
    step('cwd válido: startCursor presente', typeof ok.startCursor === 'number');

    const pwdMarker = 'PWD_IS_' + Math.random().toString(36).slice(2, 8);
    await callTool('terminal-write', { terminalId: ok.terminalId, text: `echo "${pwdMarker}:$(pwd)"` });
    // Read con reintentos: el output tarda unos ms en llegar al buffer. El
    // waitFor del smoke no se usa aquí porque el patrón colisiona con el eco
    // del propio comando (el texto tecleado contiene el marcador); el read
    // sobre el buffer completo es suficiente para esta aserción.
    let pwdOut = '';
    for (let i = 0; i < 20 && !pwdOut.includes(`${pwdMarker}:/tmp`); i++) {
      await sleep(300);
      const rr: any = await callTool('terminal-read', { terminalId: ok.terminalId });
      pwdOut = rr.output ?? '';
    }
    const pwdLine = pwdOut.trim().split('\n').find((l: string) => l.includes(pwdMarker) && !l.includes('echo'));
    step('cwd válido: pwd == /tmp', pwdOut.includes(`${pwdMarker}:/tmp`), pwdLine ?? '(no pwd line)');
    await callTool('terminal-destroy', { terminalId: ok.terminalId });

    // ======================================================================
    // 2. cwd inexistente → cwdApplied: false + cwdError del shell
    // ======================================================================
    const bad: any = await callTool('terminal-create', { cwd: '/no/existe/este/path' });
    step('cwd inválido: cwdApplied === false', bad.cwdApplied === false, JSON.stringify({ cwdApplied: bad.cwdApplied, cwdError: bad.cwdError }));
    step('cwd inválido: cwdError reporta el error del shell',
      typeof bad.cwdError === 'string' && /cd:.*No such file or directory/i.test(bad.cwdError),
      `cwdError=${JSON.stringify(bad.cwdError)}`);

    // La sesión sigue viva en el workdir por defecto — el agente puede usarla.
    const stillAlive: any = await callTool('terminal-write', { terminalId: bad.terminalId, text: 'echo STILL_$((6*7))' });
    step('cwd inválido: la sesión sigue usable', stillAlive.sent === true);
    await callTool('terminal-destroy', { terminalId: bad.terminalId });

    // ======================================================================
    // 3. sin cwd → cwdApplied: false, cwdError: null, cwd: null
    // ======================================================================
    const plain: any = await callTool('terminal-create', {});
    step('sin cwd: cwdApplied === false', plain.cwdApplied === false);
    step('sin cwd: cwdError === null', plain.cwdError === null);
    step('sin cwd: cwd === null', plain.cwd === null);
    await callTool('terminal-destroy', { terminalId: plain.terminalId });

    console.log(`\n=== Resultado: ${passed} OK, ${failed} FALLOS ===`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    console.error(`\n💥 Error fatal: ${error instanceof Error ? error.stack : error}`);
    process.exitCode = 1;
  } finally {
    mcaProcess?.kill();
    await server?.close();
    execSync(`docker rm -f ${CONTAINER_NAME} 2>/dev/null || true`, { stdio: 'ignore' });
  }
}

main();
