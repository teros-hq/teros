/**
 * Test de integración de scripts/rollback.sh (TER-519).
 *
 * No hay entorno de staging (TER-145) donde ensayar el rollback contra un server
 * real, así que probamos su MECÁNICA aquí, en CI, sin tocar prod: un repo git
 * temporal con dos commits (v1 bueno, v2 "roto"), stubs de `yarn`/`pm2` por PATH
 * y un health-poller stub. Verifica lo que de verdad importa del rollback: que
 * resuelve el SHA correcto y deja el working tree EXACTAMENTE en la versión
 * previa, y que NO toca nada ante entradas inválidas.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROLLBACK = resolve(import.meta.dir, '../../../scripts/rollback.sh');

function sh(cmd: string, cwd: string, pathPrefix = ''): { code: number; out: string; err: string } {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (pathPrefix) env.PATH = `${pathPrefix}:${process.env.PATH}`;
  const r = Bun.spawnSync(['bash', '-c', cmd], { cwd, env });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

function setupRepo(): { dir: string; binDir: string; v1: string; v2: string } {
  const dir = mkdtempSync(join(tmpdir(), 'teros-rb-'));
  sh(
    'git init -q && git config user.email t@t.co && git config user.name t && git config commit.gpgsign false',
    dir,
  );
  writeFileSync(join(dir, 'app.txt'), 'v1-good\n');
  sh('git add -A && git commit -qm v1', dir);
  const v1 = sh('git rev-parse HEAD', dir).out.trim();
  writeFileSync(join(dir, 'app.txt'), 'v2-broken\n');
  sh('git add -A && git commit -qm v2', dir);
  const v2 = sh('git rev-parse HEAD', dir).out.trim();

  // Stubs de los comandos externos: registran su invocación y salen 0 (no buildean
  // ni reinician de verdad — testeamos el flujo del rollback, no a yarn/pm2).
  const binDir = join(dir, '.stubbin');
  mkdirSync(binDir);
  for (const tool of ['yarn', 'pm2']) {
    const p = join(binDir, tool);
    writeFileSync(p, `#!/bin/bash\necho "${tool} $*" >> "${join(dir, '.calls')}"\nexit 0\n`);
    chmodSync(p, 0o755);
  }
  // Health-poller stub: exit 0 = sano. Untracked, así que sobrevive al git reset.
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts/wait-for-health.mjs'), 'process.exit(0)\n');
  return { dir, binDir, v1, v2 };
}

describe('rollback.sh (integración — mecánica real, sin prod)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('sin arg: revierte al SHA de .last-good-sha, reconstruye y reinicia', () => {
    const repo = setupRepo();
    dir = repo.dir;
    writeFileSync(join(dir, '.last-good-sha'), `${repo.v1}\n`);

    const r = sh(`APP_PATH="${dir}" HEALTH_URL="http://x" bash "${ROLLBACK}"`, dir, repo.binDir);

    expect(r.code).toBe(0);
    expect(sh('git rev-parse HEAD', dir).out.trim()).toBe(repo.v1); // revirtió al SHA correcto
    expect(readFileSync(join(dir, 'app.txt'), 'utf8')).toBe('v1-good\n'); // working tree = v1
    const calls = readFileSync(join(dir, '.calls'), 'utf8');
    expect(calls).toContain('yarn install --frozen-lockfile'); // reconstruyó
    expect(calls).toContain('pm2 restart teros-backend'); // reinició
  });

  it('con SHA explícito: revierte a ese SHA (sin necesitar .last-good-sha)', () => {
    const repo = setupRepo();
    dir = repo.dir;

    const r = sh(`APP_PATH="${dir}" HEALTH_URL="http://x" bash "${ROLLBACK}" ${repo.v1}`, dir, repo.binDir);

    expect(r.code).toBe(0);
    expect(sh('git rev-parse HEAD', dir).out.trim()).toBe(repo.v1);
  });

  it('sin arg y sin .last-good-sha: falla limpio, NO revierte a ciegas', () => {
    const repo = setupRepo();
    dir = repo.dir;

    const r = sh(`APP_PATH="${dir}" HEALTH_URL="http://x" bash "${ROLLBACK}"`, dir, repo.binDir);

    expect(r.code).toBe(1);
    expect(sh('git rev-parse HEAD', dir).out.trim()).toBe(repo.v2); // HEAD intacto
  });

  it('SHA inválido: falla limpio sin resetear', () => {
    const repo = setupRepo();
    dir = repo.dir;

    const r = sh(`APP_PATH="${dir}" HEALTH_URL="http://x" bash "${ROLLBACK}" deadbeefdeadbeef00`, dir, repo.binDir);

    expect(r.code).toBe(1);
    expect(sh('git rev-parse HEAD', dir).out.trim()).toBe(repo.v2); // intacto
  });
});
