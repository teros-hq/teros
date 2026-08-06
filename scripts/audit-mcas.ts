#!/usr/bin/env npx tsx

/**
 * MCA Audit Runner — batch validation for TER-186
 *
 * Standalone runner that spawns each MCA via tsx, connects over MCP stdio,
 * lists tools, runs health-check if available, and writes a Markdown report.
 *
 * Usage:
 *   npx tsx scripts/audit-mcas.ts [--only mca.trello,mca.linear] [--timeout 15000]
 *
 * Output: docs/audit/mca-status-<YYYY-MM-DD>.{md,json}
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { join, resolve } from 'path';
import { parseArgs } from 'util';
import { WebSocketServer, type WebSocket } from 'ws';

// =============================================================================
// TYPES
// =============================================================================

interface McaAuditResult {
  mcaId: string;
  name: string;
  enabled: boolean;
  hidden: boolean;
  transport: string;
  l0: 'pass' | 'fail';
  l1: 'pass' | 'fail' | 'timeout' | 'error';
  toolsCount: number;
  toolsList: string[];
  l2: 'pass' | 'degraded' | 'missing' | 'fail' | 'skip';
  healthStatus?: string;
  healthIssues?: Array<{ code: string; message: string }>;
  error?: string;
  durationMs: number;
  stderr?: string;
}

interface Args {
  only?: string[];
  timeout: number;
  outputDir: string;
}

// =============================================================================
// CONFIG
// =============================================================================

const REPO_ROOT = resolve(__dirname, '..');
const MCAS_DIR = join(REPO_ROOT, 'mcas');

const HEALTH_CHECK_NAMES = ['-health-check', '_health_check', 'health-check'];

// =============================================================================
// MOCK BACKEND — minimal WS server that answers secrets requests with empty
// =============================================================================

class MockBackend {
  private wss: WebSocketServer;
  private httpServer: ReturnType<typeof createServer>;
  private port: number;
  private client: WebSocket | null = null;
  connected = false;

  constructor(private readyPromise: Promise<number>) {
    this.httpServer = createServer(this.handleHttp.bind(this));
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: WebSocket) => {
      this.client = ws;
      this.connected = true;

      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'get_system_secrets') {
            ws.send(
              JSON.stringify({ type: 'system_secrets', requestId: msg.requestId, secrets: {} }),
            );
          } else if (msg.type === 'get_user_secrets') {
            ws.send(
              JSON.stringify({ type: 'user_secrets', requestId: msg.requestId, secrets: null }),
            );
          } else if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch {
          // ignore
        }
      });

      ws.on('close', () => {
        this.connected = false;
      });
    });

    this.port = 0;
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-App-Id, X-Mca-Id',
      });
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk.toString()));
    req.on('end', () => {
      const url = req.url || '';
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');

      // Secret endpoints — return empty so MCA knows no creds configured
      if (url.endsWith('/secrets/system')) {
        res.writeHead(200);
        res.end(JSON.stringify({ secrets: null }));
        return;
      }
      if (url.endsWith('/secrets/user')) {
        res.writeHead(200);
        res.end(JSON.stringify({ secrets: null, authenticated: false }));
        return;
      }
      if (url.endsWith('/secrets/user/update')) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        return;
      }
      if (url.endsWith('/health')) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'mock' }));
        return;
      }
      // Resource, events, data, auth errors — generic success
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, mock: true }));
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(0, () => {
        this.port = (this.httpServer.address() as any).port;
        resolve();
      });
    });
  }

  getWsUrl(appId: string): string {
    return `ws://localhost:${this.port}/mca?appId=${appId}&token=audit_mock`;
  }

  getHttpUrl(): string {
    return `http://localhost:${this.port}`;
  }

  getCallbackUrl(channelId: string): string {
    return `http://localhost:${this.port}/mca/callback/${channelId}`;
  }

  close() {
    try {
      this.client?.close();
    } catch {}
    try {
      this.wss.close();
    } catch {}
    try {
      this.httpServer.close();
    } catch {}
  }
}

// =============================================================================
// CATALOG
// =============================================================================

async function listMcas(): Promise<string[]> {
  const entries = await readdir(MCAS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('mca.'))
    .map((e) => e.name)
    .sort();
}

interface Manifest {
  name: string;
  enabled: boolean;
  hidden: boolean;
  entrypoint: string;
  transport: string;
}

function readManifest(mcaId: string): Manifest | null {
  const p = join(MCAS_DIR, mcaId, 'manifest.json');
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf-8'));
    return {
      name: m.name ?? mcaId,
      enabled: m.availability?.enabled ?? false,
      hidden: m.availability?.hidden ?? false,
      entrypoint: m.entrypoint ?? './src/index.ts',
      transport: m.runtime?.transport ?? 'http',
    };
  } catch {
    return null;
  }
}

// =============================================================================
// AUDIT ONE MCA
// =============================================================================

async function auditMca(mcaId: string, timeoutMs: number): Promise<McaAuditResult> {
  const start = Date.now();
  const manifest = readManifest(mcaId);

  if (!manifest) {
    return {
      mcaId,
      name: mcaId,
      enabled: false,
      hidden: false,
      transport: 'unknown',
      l0: 'fail',
      l1: 'fail',
      toolsCount: 0,
      toolsList: [],
      l2: 'skip',
      error: 'manifest.json missing or invalid',
      durationMs: Date.now() - start,
    };
  }

  const mcaDir = join(MCAS_DIR, mcaId);
  const mockBackend = new MockBackend(Promise.resolve(0));
  await mockBackend.start();

  const appId = 'audit_app_001';
  const userId = 'audit_user_001';
  const channelId = 'audit_channel_001';

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MCA_TRANSPORT: 'stdio',
    MCA_APP_ID: appId,
    MCA_APP_NAME: manifest.name,
    MCA_MCP_ID: mcaId,
    MCA_WS_ENABLED: 'true',
    MCA_WS_URL: mockBackend.getWsUrl(appId),
    MCA_BACKEND_URL: mockBackend.getHttpUrl(),
    MCA_USER_ID: userId,
    MCA_CHANNEL_ID: channelId,
    MCA_CALLBACK_URL: mockBackend.getCallbackUrl(channelId),
  };

  let transport: StdioClientTransport | null = null;
  let client: Client | null = null;
  let stderrBuf = '';

  try {
    transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', manifest.entrypoint],
      cwd: mcaDir,
      env,
      stderr: 'pipe',
    });

    // Capture stderr if pipe is exposed
    const stderrStream: NodeJS.ReadableStream | null = (transport as any).stderr ?? null;
    if (stderrStream) {
      stderrStream.on('data', (d: Buffer) => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
      });
    }

    client = new Client({ name: 'audit-runner', version: '1.0.0' }, { capabilities: {} });

    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Connection timeout (${timeoutMs}ms)`)), timeoutMs),
    );

    await Promise.race([connectPromise, timeoutPromise]);

    // Small grace period for background WS connection
    await new Promise((r) => setTimeout(r, 300));

    const toolsResponse = await client.listTools();
    const tools = toolsResponse.tools.map((t) => t.name);

    let l2: McaAuditResult['l2'] = 'missing';
    let healthStatus: string | undefined;
    let healthIssues: Array<{ code: string; message: string }> | undefined;

    const healthName = HEALTH_CHECK_NAMES.find((n) => tools.includes(n));
    if (healthName) {
      try {
        const hc = await Promise.race([
          client.callTool({ name: healthName, arguments: {} }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('health-check timeout')), 8000),
          ),
        ]);
        const text = (hc as any).content?.[0]?.text;
        if (text) {
          const parsed = JSON.parse(text);
          healthStatus = parsed.status;
          healthIssues = parsed.issues;
          if (parsed.status === 'ready') l2 = 'pass';
          else if (parsed.status === 'degraded') l2 = 'degraded';
          else l2 = 'fail';
        } else {
          l2 = 'fail';
        }
      } catch (e: any) {
        l2 = 'fail';
        healthIssues = [{ code: 'HEALTH_CHECK_THREW', message: String(e?.message ?? e) }];
      }
    }

    return {
      mcaId,
      name: manifest.name,
      enabled: manifest.enabled,
      hidden: manifest.hidden,
      transport: manifest.transport,
      l0: 'pass',
      l1: 'pass',
      toolsCount: tools.length,
      toolsList: tools,
      l2,
      healthStatus,
      healthIssues,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const l1: McaAuditResult['l1'] = message.toLowerCase().includes('timeout') ? 'timeout' : 'fail';
    return {
      mcaId,
      name: manifest.name,
      enabled: manifest.enabled,
      hidden: manifest.hidden,
      transport: manifest.transport,
      l0: 'pass',
      l1,
      toolsCount: 0,
      toolsList: [],
      l2: 'skip',
      error: message,
      durationMs: Date.now() - start,
      stderr: stderrBuf.slice(-800),
    };
  } finally {
    try {
      await client?.close();
    } catch {}
    try {
      await transport?.close();
    } catch {}
    mockBackend.close();
  }
}

// =============================================================================
// REPORT
// =============================================================================

const ICON = {
  pass: '✅',
  fail: '❌',
  timeout: '⏱️',
  error: '⚠️',
  degraded: '🟡',
  missing: '➖',
  skip: '—',
} as const;

function renderReport(results: McaAuditResult[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const total = results.length;
  const l1Pass = results.filter((r) => r.l1 === 'pass').length;
  const l1Fail = results.filter((r) => r.l1 !== 'pass').length;
  const l2Pass = results.filter((r) => r.l2 === 'pass').length;
  const l2Degraded = results.filter((r) => r.l2 === 'degraded').length;
  const disabled = results.filter((r) => !r.enabled).length;

  const header = `# MCA Audit Report — ${date}

Generado por \`npx tsx scripts/audit-mcas.ts\`.

## Resumen ejecutivo

- **Total MCAs:** ${total}
- **L1 startup pass:** ${l1Pass}/${total}
- **L1 fail / error / timeout:** ${l1Fail}/${total}
- **L2 health-check ready:** ${l2Pass}/${total}
- **L2 health-check degraded:** ${l2Degraded}/${total}
- **Deshabilitadas en manifest (\`enabled: false\`):** ${disabled}/${total}

## Leyenda

- **L0** — Estructural (manifest + entrypoint válidos)
- **L1** — Startup (MCA arranca, conecta al cliente MCP vía stdio, registra tools)
- **L2** — Health-check (tool \`-health-check\` o \`_health_check\` responde \`ready\`)

Icons: ✅ pass · ❌ fail · ⏱️ timeout · ⚠️ error · 🟡 degraded · ➖ sin health-check · — skipped

## Resultado por MCA

| # | MCA | Enabled | Transport | L0 | L1 | Tools | L2 | Health | Duración | Error |
|---|-----|---------|-----------|----|----|-------|----|--------|----------|-------|
`;

  const rows = results
    .map((r, i) => {
      const enabled = r.enabled ? '✓' : '✗';
      const errorShort = r.error
        ? r.error.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 80)
        : '';
      const health = r.healthStatus ?? '';
      return `| ${i + 1} | \`${r.mcaId}\` | ${enabled} | ${r.transport} | ${ICON[r.l0]} | ${ICON[r.l1]} | ${r.toolsCount} | ${ICON[r.l2]} | ${health} | ${r.durationMs}ms | ${errorShort} |`;
    })
    .join('\n');

  const details = results
    .filter((r) => r.l1 !== 'pass' || r.l2 === 'fail' || r.l2 === 'degraded')
    .map((r) => {
      const parts: string[] = [`### ${r.mcaId}`];
      parts.push(`- **L1:** ${r.l1} · **L2:** ${r.l2} · **Duration:** ${r.durationMs}ms`);
      if (r.error) parts.push(`- **Error:** ${r.error}`);
      if (r.healthStatus) parts.push(`- **Health status:** ${r.healthStatus}`);
      if (r.healthIssues?.length) {
        parts.push('- **Health issues:**');
        for (const issue of r.healthIssues) {
          parts.push(`  - \`${issue.code}\`: ${issue.message}`);
        }
      }
      if (r.stderr) {
        parts.push(
          '\n<details><summary>stderr (truncated)</summary>\n\n```\n' +
            r.stderr +
            '\n```\n</details>',
        );
      }
      return parts.join('\n');
    })
    .join('\n\n');

  return `${header}${rows}\n\n## Detalle de MCAs con problemas\n\n${details || '_Sin problemas detectados._'}\n`;
}

// =============================================================================
// MAIN
// =============================================================================

async function parseCliArgs(): Promise<Args> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      only: { type: 'string' },
      timeout: { type: 'string', default: '15000' },
      'output-dir': { type: 'string', default: 'docs/audit' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(
      'Usage: npx tsx scripts/audit-mcas.ts [--only mca.trello,mca.linear] [--timeout 15000] [--output-dir docs/audit]',
    );
    process.exit(0);
  }

  return {
    only: values.only ? values.only.split(',').map((s) => s.trim()) : undefined,
    timeout: Number(values.timeout),
    outputDir: String(values['output-dir']),
  };
}

async function main() {
  const args = await parseCliArgs();

  const all = await listMcas();
  const target = args.only ? all.filter((m) => args.only!.includes(m)) : all;

  if (target.length === 0) {
    console.error('No MCAs matched. Available:', all.slice(0, 10).join(', '), '...');
    process.exit(1);
  }

  console.error(
    `Auditing ${target.length} MCA(s). Per-MCA timeout: ${args.timeout}ms.\n`,
  );

  const results: McaAuditResult[] = [];
  for (let i = 0; i < target.length; i++) {
    const mcaId = target[i];
    process.stderr.write(`[${i + 1}/${target.length}] ${mcaId}... `);
    const r = await auditMca(mcaId, args.timeout);
    results.push(r);
    process.stderr.write(
      `L1:${r.l1} L2:${r.l2} tools:${r.toolsCount} ${r.durationMs}ms\n`,
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(REPO_ROOT, args.outputDir);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `mca-status-${date}.md`);
  const jsonPath = join(outDir, `mca-status-${date}.json`);

  writeFileSync(outPath, renderReport(results));
  writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  const l1Pass = results.filter((r) => r.l1 === 'pass').length;
  const l2Pass = results.filter((r) => r.l2 === 'pass').length;
  console.error(`\nL1 pass: ${l1Pass}/${results.length}`);
  console.error(`L2 pass: ${l2Pass}/${results.length}`);
  console.error(`Report:  ${outPath}`);
  console.error(`Raw:     ${jsonPath}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
