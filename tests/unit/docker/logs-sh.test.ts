/**
 * docker/logs.sh (spec SHLOG) — run against a `docker` stub on PATH that
 * records its arguments instead of following anything.
 */
import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '../../../docker/logs.sh');

function run(args: string[]): string {
  const bin = mkdtempSync(join(tmpdir(), 'logs-sh-'));
  const calls = join(bin, 'calls');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$*" > "${calls}"\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  const result = Bun.spawnSync(['sh', SCRIPT, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  expect(result.exitCode).toBe(0);
  return readFileSync(calls, 'utf-8').trim();
}

describe('docker/logs.sh', () => {
  it('[SHLOG-AC-1] with no arguments follows backend, container-agent and frontend only', () => {
    expect(run([])).toBe('compose logs -f --tail=200 backend container-agent frontend');
  });

  it('[SHLOG-AC-2] with arguments follows exactly the services named', () => {
    expect(run(['mongodb', 'qdrant'])).toBe('compose logs -f --tail=200 mongodb qdrant');
  });
});
