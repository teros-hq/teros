/**
 * Unit tests — HttpFileHandler (handlers/http-file-handler.ts)
 *
 * Verifies:
 *   1. workspaceId como parámetro de query (fast-path, sin lookup de canal)
 *   2. channelId como fallback (backward compat con mensajes viejos)
 *   3. workspaceId tiene prioridad sobre channelId cuando ambos están presentes
 *   4. 400 cuando faltan path y/o ambos identificadores
 *   5. 405 en métodos no GET
 *   6. 401 sin token de auth
 *   7. 200 cuando el archivo existe, 404 cuando no
 *
 * No requiere servidor HTTP ni MongoDB real — todas las dependencias son mocks.
 * Usa /tmp para controlar fs sin mockear el módulo node:fs.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpFileHandler } from '../../src/handlers/http-file-handler';

// ---------------------------------------------------------------------------
// Temp directory + fixture file
// ---------------------------------------------------------------------------

const TEST_BASE = `/tmp/teros-test-hfh-${Date.now()}`;
const VOL_HOST_PATH = join(TEST_BASE, 'vol_work_abc');
const HTML_FILE = join(VOL_HOST_PATH, 'report.html');

beforeAll(() => {
  mkdirSync(VOL_HOST_PATH, { recursive: true });
  writeFileSync(HTML_FILE, '<h1>Hello</h1>');
});

afterAll(() => {
  rmSync(TEST_BASE, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const AUTH_TOKEN = 'valid-token-123';
const USER_ID = 'user_abc';

function makeAuth(valid: boolean) {
  return {
    validateSession: mock(async () =>
      valid
        ? { success: true, user: { userId: USER_ID } }
        : { success: false },
    ),
  } as any;
}

function makeVolumeService(hostPath: string | null) {
  return {
    getVolume: mock(async () => (hostPath ? { volumeId: 'vol_work_abc', hostPath } : null)),
  } as any;
}

function makeWorkspaceService(volumeId: string | null) {
  return {
    getWorkspace: mock(async () =>
      volumeId !== null ? { workspaceId: 'work_abc', volumeId } : { workspaceId: 'work_abc' },
    ),
    // SEC-2 (A3): these tests exercise file serving, not authz — authorize the
    // caller so the gate passes. The gate itself is covered in access-idor-sec2.
    canAccess: mock(async () => true),
  } as any;
}

function makeChannelManager() {
  return { canAccessChannel: mock(async () => true) } as any;
}

function makeDb(channelWorkspaceId: string | null) {
  const findOne = mock(async () =>
    channelWorkspaceId ? { channelId: 'ch_xyz', workspaceId: channelWorkspaceId } : null,
  );
  return { collection: mock(() => ({ findOne })) } as any;
}

/** Minimal IncomingMessage mock */
function makeReq(opts: { method?: string; url?: string; authToken?: string | null } = {}) {
  return {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/api/files',
    headers: {
      host: 'localhost:3000',
      ...(opts.authToken !== null
        ? { authorization: `Bearer ${opts.authToken ?? AUTH_TOKEN}` }
        : {}),
    },
  } as any;
}

/** Captures res.writeHead + res.end for assertions */
function makeRes() {
  let statusCode = 0;
  let headers: Record<string, string> = {};
  let body = '';
  return {
    writeHead: mock((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      headers = hdrs ?? {};
    }),
    end: mock((data?: string) => {
      body = data ?? '';
    }),
    get statusCode() { return statusCode; },
    get headers() { return headers; },
    get body() { return body; },
  };
}

// ---------------------------------------------------------------------------
// Helpers to build the handler + call handleRoute
// ---------------------------------------------------------------------------

function makeHandler(opts: { authValid?: boolean; hostPath?: string | null; workspaceVolumeId?: string | null; channelWorkspaceId?: string | null } = {}) {
  // channelWorkspaceId puede ser explícitamente null (canal sin workspace) o undefined (usar default)
  const channelWsId = opts.channelWorkspaceId !== undefined ? opts.channelWorkspaceId : 'work_abc';
  return new HttpFileHandler(
    makeDb(channelWsId),
    makeAuth(opts.authValid ?? true),
    makeVolumeService(opts.hostPath ?? VOL_HOST_PATH),
    makeWorkspaceService(opts.workspaceVolumeId ?? 'vol_work_abc'),
    makeChannelManager(),
  );
}

async function handle(handler: HttpFileHandler, url: string, reqOpts: Parameters<typeof makeReq>[0] = {}) {
  const req = makeReq({ ...reqOpts, url });
  const res = makeRes();
  const handled = await handler.handleRoute(req, res, url);
  return { handled, res };
}

// ---------------------------------------------------------------------------
// Routing — solo coincide con /api/files
// ---------------------------------------------------------------------------

describe('HttpFileHandler — routing', () => {
  it('no maneja rutas distintas de /api/files', async () => {
    const { handled } = await handle(makeHandler(), '/api/other');
    expect(handled).toBe(false);
  });

  it('rechaza métodos distintos de GET con 405', async () => {
    const { handled, res } = await handle(makeHandler(), '/api/files', { method: 'POST' });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Validación de parámetros — 400
// ---------------------------------------------------------------------------

describe('HttpFileHandler — validación de parámetros', () => {
  it('400 cuando falta path y cualquier identificador', async () => {
    const { res } = await handle(makeHandler(), '/api/files');
    expect(res.statusCode).toBe(400);
  });

  it('400 cuando falta path (aunque workspaceId esté presente)', async () => {
    const { res } = await handle(makeHandler(), '/api/files?workspaceId=work_abc');
    expect(res.statusCode).toBe(400);
  });

  it('400 cuando falta path (aunque channelId esté presente)', async () => {
    const { res } = await handle(makeHandler(), '/api/files?channelId=ch_xyz');
    expect(res.statusCode).toBe(400);
  });

  it('400 cuando hay path pero no hay workspaceId ni channelId', async () => {
    const { res } = await handle(makeHandler(), '/api/files?path=%2Fworkspace%2Freport.html');
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Autenticación — 401
// ---------------------------------------------------------------------------

describe('HttpFileHandler — autenticación', () => {
  it('401 sin header Authorization', async () => {
    const { res } = await handle(
      makeHandler(),
      '/api/files?path=%2Fworkspace%2Freport.html&workspaceId=work_abc',
      { authToken: null },
    );
    expect(res.statusCode).toBe(401);
  });

  it('401 con token inválido', async () => {
    const { res } = await handle(
      makeHandler({ authValid: false }),
      '/api/files?path=%2Fworkspace%2Freport.html&workspaceId=work_abc',
    );
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// workspaceId — fast-path (sin lookup de canal)
// ---------------------------------------------------------------------------

describe('HttpFileHandler — workspaceId (fast-path)', () => {
  it('sirve el archivo con ?workspaceId=work_abc', async () => {
    const { res } = await handle(
      makeHandler(),
      `/api/files?path=%2Fworkspace%2Freport.html&workspaceId=work_abc`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<h1>Hello</h1>');
  });

  it('workspaceId tiene prioridad sobre channelId cuando ambos están presentes', async () => {
    // workspaceId resuelve a un volumen existente; channelId apuntaría a otro workspace
    const { res } = await handle(
      makeHandler({ channelWorkspaceId: 'work_other' }),
      `/api/files?path=%2Fworkspace%2Freport.html&workspaceId=work_abc&channelId=ch_xyz`,
    );
    // Debe usar workspaceId → vol existente → 200
    expect(res.statusCode).toBe(200);
  });

  it('404 cuando el archivo no existe en el volumen', async () => {
    const { res } = await handle(
      makeHandler(),
      `/api/files?path=%2Fworkspace%2Finexistente.html&workspaceId=work_abc`,
    );
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// channelId — fallback (backward compat)
// ---------------------------------------------------------------------------

describe('HttpFileHandler — channelId (fallback / backward compat)', () => {
  it('sirve el archivo con ?channelId=ch_xyz cuando el canal tiene workspaceId', async () => {
    const { res } = await handle(
      makeHandler({ channelWorkspaceId: 'work_abc' }),
      `/api/files?path=%2Fworkspace%2Freport.html&channelId=ch_xyz`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<h1>Hello</h1>');
  });

  it('400 cuando el canal no existe en DB', async () => {
    const { res } = await handle(
      makeHandler({ channelWorkspaceId: null }),
      `/api/files?path=%2Fworkspace%2Freport.html&channelId=ch_missing`,
    );
    expect(res.statusCode).toBe(400);
  });
});
