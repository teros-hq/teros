/**
 * E2E test driver for mca.teros.terminal
 *
 * Spawns the harness (real backend terminal handlers + real host PTY) and the
 * MCA under test (stdio MCP), then exercises all 7 tools in sequence with
 * assertions. Exits 0 only if every step passes.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, type ChildProcess } from 'child_process';

const MCA_DIR = '/opt/teros/mcas/mca.teros.terminal';
const APP_ID = 'app_cbc12f0408ef4dab';

let harness: ChildProcess | null = null;
let failures = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitForLine(proc: ChildProcess, marker: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.stdout?.off('data', onData);
      reject(new Error(`timeout waiting for "${marker}" from harness`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes(marker)) {
        clearTimeout(timer);
        proc.stdout?.off('data', onData);
        resolve();
      }
    };
    proc.stdout?.on('data', onData);
  });
}

async function main() {
  // ── 1. Start harness ──
  console.log('▶ Starting harness (real terminal handlers + real host PTY)...');
  harness = spawn('npx', ['tsx', '/opt/teros/scripts/tests/terminal-e2e/harness.ts'], {
    cwd: '/opt/teros/packages/backend',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  harness.stderr?.on('data', (d) => process.stderr.write(`[harness:err] ${d}`));
  await waitForLine(harness, 'HARNESS_READY', 30000);
  console.log('  harness ready');

  // ── 2. Start MCA under test (stdio MCP) ──
  console.log('▶ Starting mca.teros.terminal (stdio)...');
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    cwd: MCA_DIR,
    stderr: 'pipe',
    env: {
      ...(process.env as Record<string, string>),
      MCA_TRANSPORT: 'stdio',
      MCA_APP_ID: APP_ID,
      MCA_WS_URL: `ws://localhost:18080?appId=${APP_ID}&token=e2e-test`,
    } as any,
  });
  transport.stderr?.on('data', (d: Buffer) => process.stderr.write(`[mca:err] ${d}`));
  const client = new Client({ name: 'terminal-e2e', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  console.log('  MCA connected');

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text: string }> | undefined;
    const text = content?.map((c) => c.text).join('\n') ?? '';
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // keep text
    }
    return data;
  };

  // ── 3. Tool sequence ──
  console.log('▶ terminal-create');
  const created = await call('terminal-create', { cols: 100, rows: 30 });
  console.log('   →', JSON.stringify(created));
  check('returns terminalId', typeof created?.terminalId === 'string' && created.terminalId.length > 0);
  check('status ready', created?.status === 'ready');
  const tid = created.terminalId as string;

  console.log('▶ terminal-write (echo command with sendEnter)');
  const wrote = await call('terminal-write', { terminalId: tid, text: 'echo HELLO_ROUNDTRIP_$((40+2))' });
  console.log('   →', JSON.stringify(wrote));
  check('sent:true', wrote?.sent === true);

  await new Promise((r) => setTimeout(r, 800));

  console.log('▶ terminal-read (round-trip output)');
  const read = await call('terminal-read', { terminalId: tid });
  console.log('   → output:', JSON.stringify((read?.output ?? '').slice(-300)));
  check('output contains command result', typeof read?.output === 'string' && read.output.includes('HELLO_ROUNDTRIP_42'));
  check('cursor is a number', typeof read?.cursor === 'number');

  console.log('▶ terminal-wait-for (match)');
  await call('terminal-write', { terminalId: tid, text: 'echo MARKER_12345' });
  const wait = await call('terminal-wait-for', { terminalId: tid, pattern: 'MARKER_12345', timeoutMs: 5000 });
  console.log('   →', JSON.stringify(wait));
  check('matched:true', wait?.matched === true);
  check('matched line contains marker', typeof wait?.output === 'string' && wait.output.includes('MARKER_12345'));

  console.log('▶ terminal-wait-for (timeout → matched:false)');
  const waitOut = await call('terminal-wait-for', { terminalId: tid, pattern: 'NEVER_APPEARS_XYZ', timeoutMs: 2000 });
  console.log('   →', JSON.stringify(waitOut));
  check('matched:false on timeout', waitOut?.matched === false && waitOut?.timedOut === true);

  console.log('▶ terminal-send-key (ctrl-c + enter)');
  const key = await call('terminal-send-key', { terminalId: tid, key: 'ctrl-c' });
  console.log('   →', JSON.stringify(key));
  check('ctrl-c sequence \\x03', key?.sent === true && key?.sequence === '\\x03');
  const keyUp = await call('terminal-send-key', { terminalId: tid, key: 'up' });
  check('up sequence \\x1b[A', keyUp?.sequence === '\\x1b[A');

  console.log('▶ terminal-list (session visible)');
  const list = await call('terminal-list', {});
  console.log('   →', JSON.stringify(list).slice(0, 400));
  check('session in list', Array.isArray(list?.sessions) && list.sessions.some((s: any) => s.terminalId === tid));

  console.log('▶ terminal-destroy');
  const destroyed = await call('terminal-destroy', { terminalId: tid });
  console.log('   →', JSON.stringify(destroyed));
  check('destroyed:true', destroyed?.destroyed === true);

  console.log('▶ terminal-read after destroy (error path)');
  let readAfterError = '';
  try {
    const res = await call('terminal-read', { terminalId: tid });
    readAfterError = typeof res === 'string' ? res : JSON.stringify(res);
  } catch (err: any) {
    readAfterError = String(err?.message ?? err);
  }
  console.log('   →', readAfterError.slice(0, 200));
  check('TERMINAL_NOT_FOUND after destroy', readAfterError.toLowerCase().includes('not found'));

  console.log('▶ terminal-list after destroy (session gone)');
  const list2 = await call('terminal-list', {});
  check('session removed from list', Array.isArray(list2?.sessions) && !list2.sessions.some((s: any) => s.terminalId === tid));

  // ── 4. Done ──
  await client.close();
  harness.kill('SIGTERM');

  if (failures > 0) {
    console.error(`\n❌ E2E FAILED — ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✅ E2E PASSED — all checks green');
  process.exit(0);
}

main().catch((err) => {
  console.error('[driver] fatal:', err);
  harness?.kill('SIGTERM');
  process.exit(1);
});
