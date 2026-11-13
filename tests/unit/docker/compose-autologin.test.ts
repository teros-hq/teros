/**
 * docker-compose.yml hands the installer's auto-login answer to the backend
 * (spec ALOGIN).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const compose = readFileSync(resolve(import.meta.dir, '../../../docker-compose.yml'), 'utf-8');

/** The lines of one top-level service block. */
function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('docker-compose.yml', () => {
  it('[ALOGIN-AC-6] the backend gets TEROS_AUTOLOGIN and TEROS_AUTOLOGIN_USER from .env, empty when unset', () => {
    const backend = service('backend');
    expect(backend).toContain('TEROS_AUTOLOGIN: ${TEROS_AUTOLOGIN:-}');
    expect(backend).toContain('TEROS_AUTOLOGIN_USER: ${TEROS_AUTOLOGIN_USER:-}');
  });
});
