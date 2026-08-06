import { describe, expect, it } from 'bun:test';
import { spawnWithAbort } from '../src/process';

describe('spawnWithAbort', () => {
  it('returns exit 0 when child completes naturally', async () => {
    const result = await spawnWithAbort('/bin/bash', ['-c', 'echo hello']);
    expect(result.kind).toBe('exit');
    if (result.kind !== 'exit') throw new Error('unreachable');
    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBe(false);
  });

  it('streams stdout via onStdout callback', async () => {
    const chunks: string[] = [];
    const result = await spawnWithAbort('/bin/bash', ['-c', 'echo line1; echo line2'], {
      onStdout: (c) => chunks.push(c),
    });
    if (result.kind !== 'exit') throw new Error('unreachable');
    expect(result.exitCode).toBe(0);
    expect(chunks.join('')).toContain('line1');
    expect(chunks.join('')).toContain('line2');
  });

  it('short-circuits with cancelled=true if signal already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    const result = await spawnWithAbort('/bin/bash', ['-c', 'sleep 30'], { signal: ac.signal });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
    if (result.kind !== 'exit') throw new Error('unreachable');
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(130);
  });

  it('kills child with SIGTERM when signal aborts mid-execution', async () => {
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 100);
    const result = await spawnWithAbort('/bin/bash', ['-c', 'sleep 30'], {
      signal: ac.signal,
      killGraceMs: 100,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1500);
    if (result.kind !== 'exit') throw new Error('unreachable');
    expect(result.cancelled).toBe(true);
    expect(result.signal === 'SIGTERM' || result.signal === 'SIGKILL').toBe(true);
  });

  it('escalates to SIGKILL when SIGTERM is trapped', async () => {
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 50);
    // bash script that traps SIGTERM and refuses to die for 30s
    const script = 'trap "" TERM; sleep 30';
    const result = await spawnWithAbort('/bin/bash', ['-c', script], {
      signal: ac.signal,
      killGraceMs: 150,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1500);
    if (result.kind !== 'exit') throw new Error('unreachable');
    expect(result.cancelled).toBe(true);
    expect(result.signal).toBe('SIGKILL');
  });

  it('returns spawnError when command not found', async () => {
    const result = await spawnWithAbort('/nonexistent/binary', []);
    expect(result.kind).toBe('spawnError');
    if (result.kind !== 'spawnError') throw new Error('unreachable');
    expect(result.error).toBeInstanceOf(Error);
  });

  it('cleans up listeners when child exits before signal aborts', async () => {
    const ac = new AbortController();
    const result = await spawnWithAbort('/bin/bash', ['-c', 'echo done'], { signal: ac.signal });
    if (result.kind !== 'exit') throw new Error('unreachable');
    expect(result.cancelled).toBe(false);
    // Aborting after child already exited must not throw or leak.
    ac.abort();
    await new Promise((r) => setTimeout(r, 50));
  });
});
