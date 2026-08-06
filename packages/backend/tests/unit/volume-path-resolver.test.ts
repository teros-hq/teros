/**
 * Unit tests — resolveVolumeHostPath (lib/volume-path-resolver.ts)
 *
 * Verifies that container-side paths are correctly translated to host paths:
 *   1. Resolution via workspaceId (work_* / ws_* prefix)
 *   2. Resolution via channelId (channel → workspace → volume)
 *   3. /workspace/ prefix is stripped before joining with volumeHostPath
 *   4. Path traversal (..) is blocked
 *   5. Local dev fallback: if volume path missing, literal filePath used —
 *      ONLY for paths under the container mount (security gate: an ungated
 *      fallback was an arbitrary host file read for authenticated clients)
 *   6. Neither exists: returns volume path anyway (caller uses waitForFile)
 *   7. Error cases: channel/workspace/volume not found
 *
 * No real MongoDB — all dependencies are mocked.
 * Uses real /tmp dirs to control fs.access() results without mocking the module.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveVolumeHostPath } from '../../src/lib/volume-path-resolver';

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------

const TEST_BASE = `/tmp/teros-test-vpr-${Date.now()}`;
const VOL_HOST_PATH = join(TEST_BASE, 'vol_001');
const LITERAL_FILE = join(TEST_BASE, 'literal-fallback.html');

beforeAll(() => {
  mkdirSync(VOL_HOST_PATH, { recursive: true });
  writeFileSync(LITERAL_FILE, '<h1>test</h1>');
});

afterAll(() => {
  rmSync(TEST_BASE, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeDb(channel: { channelId: string; workspaceId?: string } | null) {
  const findOne = mock(async () => channel);
  return { collection: mock(() => ({ findOne })) } as any;
}

function makeVolumeService(hostPath: string | null) {
  return { getVolume: mock(async () => (hostPath ? { volumeId: 'vol_001', hostPath } : null)) } as any;
}

function makeWorkspaceService(volumeId: string | null) {
  return {
    getWorkspace: mock(async () =>
      volumeId !== null ? { workspaceId: 'work_abc', volumeId } : { workspaceId: 'work_abc' },
    ),
  } as any;
}

// ---------------------------------------------------------------------------
// Resolution via workspaceId
// ---------------------------------------------------------------------------

describe('resolveVolumeHostPath — workspaceId', () => {
  it('resuelve filePath bajo /workspace/ usando work_ prefix', async () => {
    const filePath = '/workspace/report.html';
    // Crear el archivo destino para que access() tenga éxito en el happy path
    writeFileSync(join(VOL_HOST_PATH, 'report.html'), '');

    const result = await resolveVolumeHostPath(
      filePath,
      'work_abc',
      makeDb(null),
      makeVolumeService(VOL_HOST_PATH),
      makeWorkspaceService('vol_001'),
    );

    expect(result).toBe(join(VOL_HOST_PATH, 'report.html'));
  });

  it('resuelve filePath usando ws_ prefix', async () => {
    writeFileSync(join(VOL_HOST_PATH, 'ws-test.html'), '');

    const result = await resolveVolumeHostPath(
      '/workspace/ws-test.html',
      'ws_abc',
      makeDb(null),
      makeVolumeService(VOL_HOST_PATH),
      makeWorkspaceService('vol_001'),
    );

    expect(result).toBe(join(VOL_HOST_PATH, 'ws-test.html'));
  });

  it('lanza error si workspaceService es null', async () => {
    await expect(
      resolveVolumeHostPath(
        '/workspace/file.html',
        'work_abc',
        makeDb(null),
        makeVolumeService(VOL_HOST_PATH),
        null,
      ),
    ).rejects.toThrow('WorkspaceService unavailable');
  });

  it('lanza error si el workspace no tiene volumeId', async () => {
    await expect(
      resolveVolumeHostPath(
        '/workspace/file.html',
        'work_abc',
        makeDb(null),
        makeVolumeService(VOL_HOST_PATH),
        makeWorkspaceService(null),
      ),
    ).rejects.toThrow('Workspace has no volume');
  });

  it('lanza error si el volumen no existe en DB', async () => {
    await expect(
      resolveVolumeHostPath(
        '/workspace/file.html',
        'work_abc',
        makeDb(null),
        makeVolumeService(null),
        makeWorkspaceService('vol_001'),
      ),
    ).rejects.toThrow('Volume not found');
  });
});

// ---------------------------------------------------------------------------
// Resolution via channelId
// ---------------------------------------------------------------------------

describe('resolveVolumeHostPath — channelId', () => {
  it('resuelve filePath vía channel → workspace → volume', async () => {
    writeFileSync(join(VOL_HOST_PATH, 'channel-test.html'), '');

    const result = await resolveVolumeHostPath(
      '/workspace/channel-test.html',
      'ch_xyz',
      makeDb({ channelId: 'ch_xyz', workspaceId: 'work_abc' }),
      makeVolumeService(VOL_HOST_PATH),
      makeWorkspaceService('vol_001'),
    );

    expect(result).toBe(join(VOL_HOST_PATH, 'channel-test.html'));
  });

  it('lanza error si el canal no existe', async () => {
    await expect(
      resolveVolumeHostPath(
        '/workspace/file.html',
        'ch_missing',
        makeDb(null),
        makeVolumeService(VOL_HOST_PATH),
        makeWorkspaceService('vol_001'),
      ),
    ).rejects.toThrow('Channel not found');
  });

  it('lanza error si el canal no tiene workspaceId', async () => {
    await expect(
      resolveVolumeHostPath(
        '/workspace/file.html',
        'ch_xyz',
        makeDb({ channelId: 'ch_xyz' }), // sin workspaceId
        makeVolumeService(VOL_HOST_PATH),
        makeWorkspaceService('vol_001'),
      ),
    ).rejects.toThrow('has no workspaceId');
  });
});

// ---------------------------------------------------------------------------
// Path prefix stripping
// ---------------------------------------------------------------------------

describe('resolveVolumeHostPath — stripping del prefijo /workspace/', () => {
  it('elimina /workspace/ al construir la ruta relativa', async () => {
    writeFileSync(join(VOL_HOST_PATH, 'mockup.html'), '');

    const result = await resolveVolumeHostPath(
      '/workspace/mockup.html',
      'work_abc',
      makeDb(null),
      makeVolumeService(VOL_HOST_PATH),
      makeWorkspaceService('vol_001'),
    );

    expect(result).toBe(join(VOL_HOST_PATH, 'mockup.html'));
    expect(result).not.toContain('/workspace/');
  });

  it('maneja ruta sin prefijo /workspace/ (path relativo directo)', async () => {
    writeFileSync(join(VOL_HOST_PATH, 'direct.html'), '');

    const result = await resolveVolumeHostPath(
      'direct.html',
      'work_abc',
      makeDb(null),
      makeVolumeService(VOL_HOST_PATH),
      makeWorkspaceService('vol_001'),
    );

    expect(result).toBe(join(VOL_HOST_PATH, 'direct.html'));
  });
});

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

describe('resolveVolumeHostPath — path traversal', () => {
  it('bloquea path con .. en la ruta relativa', async () => {
    await expect(
      resolveVolumeHostPath(
        '/workspace/../etc/passwd',
        'work_abc',
        makeDb(null),
        makeVolumeService(VOL_HOST_PATH),
        makeWorkspaceService('vol_001'),
      ),
    ).rejects.toThrow('path traversal detected');
  });

  it('bloquea path con .. sin prefijo /workspace/', async () => {
    await expect(
      resolveVolumeHostPath(
        '../../secret.txt',
        'work_abc',
        makeDb(null),
        makeVolumeService(VOL_HOST_PATH),
        makeWorkspaceService('vol_001'),
      ),
    ).rejects.toThrow('path traversal detected');
  });

  it('permite nombres con .. embebido (no es traversal real)', async () => {
    // ..foo y foo..bar son nombres válidos: solo bloqueamos segmentos '..' literales
    writeFileSync(join(VOL_HOST_PATH, '..foo'), '');

    const result = await resolveVolumeHostPath(
      '/workspace/..foo',
      'work_abc',
      makeDb(null),
      makeVolumeService(VOL_HOST_PATH),
      makeWorkspaceService('vol_001'),
    );

    expect(result).toBe(join(VOL_HOST_PATH, '..foo'));
  });
});

// ---------------------------------------------------------------------------
// Local dev fallback
// ---------------------------------------------------------------------------

describe('resolveVolumeHostPath — fallback y casos de no-existencia', () => {
  it('NO devuelve un literal fuera del container mount aunque exista (regresión host-read)', async () => {
    // Antes del fix: LITERAL_FILE (path arbitrario del host) existe → se
    // devolvía tal cual y el caller hacía fs.readFile/fs.watch sobre él.
    // Eso era una lectura arbitraria de archivos del host para cualquier
    // cliente autenticado (p.ej. /etc/passwd). Ahora el fallback literal
    // queda restringido a paths bajo /workspace.
    const missingVol = join(TEST_BASE, 'vol_missing');

    const result = await resolveVolumeHostPath(
      LITERAL_FILE,
      'work_abc',
      makeDb(null),
      makeVolumeService(missingVol),
      makeWorkspaceService('vol_001'),
    );

    expect(result).toBe(join(missingVol, LITERAL_FILE.slice(1)));
    expect(result).not.toBe(LITERAL_FILE);
  });

  it('/etc/hosts existente NUNCA se devuelve literal (exploit directo)', async () => {
    const missingVol = join(TEST_BASE, 'vol_missing');

    const result = await resolveVolumeHostPath(
      '/etc/hosts',
      'work_abc',
      makeDb(null),
      makeVolumeService(missingVol),
      makeWorkspaceService('vol_001'),
    );

    expect(result).toBe(join(missingVol, 'etc/hosts'));
  });

  it('SÍ mantiene el fallback literal para paths bajo el container mount (backend dentro del contenedor)', async () => {
    // Simula el mount inyectando containerMount=TEST_BASE: el "literal" es un
    // path bajo el mount que existe en disco mientras el del volumen no.
    const missingVol = join(TEST_BASE, 'vol_missing');

    const result = await resolveVolumeHostPath(
      LITERAL_FILE, // = TEST_BASE/literal-fallback.html → bajo el mount inyectado
      'work_abc',
      makeDb(null),
      makeVolumeService(missingVol),
      makeWorkspaceService('vol_001'),
      TEST_BASE,
    );

    expect(result).toBe(LITERAL_FILE);
  });

  it('devuelve la ruta del volumen cuando ninguna de las dos existe (caller maneja el waitForFile)', async () => {
    const missingVol = join(TEST_BASE, 'vol_missing');

    const result = await resolveVolumeHostPath(
      '/workspace/not-yet-written.html',
      'work_abc',
      makeDb(null),
      makeVolumeService(missingVol),
      makeWorkspaceService('vol_001'),
    );

    // Debe devolver el path del volumen (no el path literal), para que el caller
    // pueda esperar a que aparezca el archivo con waitForFile
    expect(result).toBe(join(missingVol, 'not-yet-written.html'));
  });
});
