/**
 * Regression — HEAD /objects/:objectId must reach the storage router (200 with
 * Content-Length, empty body), not fall through to the edge 404.
 *
 * Incident 2026-11-01: the edge gate in createHttpHandler filtered
 * `method === 'GET'`, so HEAD never reached agentAppsStorageRoutes (which
 * accepts GET||HEAD) and fell through to the plain-text 404. A `curl -I`
 * then "proved" an intact 29MB video destroyed (it wasn't).
 *
 * This test exercises the REAL createHttpHandler edge — the router alone was
 * already correct and its own integration tests passed, so they could never
 * catch this. A fake db keeps it Mongo-free.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpHandler } from '../../src/bootstrap/http-server';
import { createAgentAppsStorageRoutes } from '../../src/routes/agent-apps-storage-routes';

const OBJECT_ID = 'obj_abcdef1234567890';
const OBJECT_CONTENT = 'regression-head-body';

const objDir = mkdtempSync(join(tmpdir(), 'objects-head-test-'));
const objPath = join(objDir, 'object.bin');
writeFileSync(objPath, OBJECT_CONTENT);

const fakeDb = {
  collection: (_name: string) => ({
    findOne: async ({ objectId }: { objectId: string }) =>
      objectId === OBJECT_ID
        ? { objectId, path: objPath, contentType: 'text/plain' }
        : null,
  }),
} as any;

let httpServer: Server;
let baseUrl: string;

beforeAll(async () => {
  const storageRoutes = createAgentAppsStorageRoutes({
    db: fakeDb,
    // Public GET/HEAD never touches the callback handlers — a stub keeps the
    // real CallbackHandlers (and its Mongo expectations) out of this test.
    callbackHandlers: {} as any,
  });

  const handler = createHttpHandler({
    adminRoutes: async () => false,
    boardRoutes: async () => false,
    automateRoutes: async () => false,
    mcaCallbackRoutes: async () => false,
    providerOAuthRoutes: async () => false,
    g2Routes: async () => false,
    authHandler: {} as any,
    mcaAuthHandler: {} as any,
    githubWebhookHandler: {} as any,
    appWebhookHandler: {} as any,
    flowWebhookHandler: {} as any,
    uploadHandler: {} as any,
    mediaHandler: {} as any,
    fileHandler: {} as any,
    shareHandler: {} as any,
    eventHandler: {} as any,
    mcaEventSubscriptionService: {} as any,
    sessionManager: {} as any,
    mcaManager: null,
    agentAppsStorageRoutes: storageRoutes,
    db: fakeDb,
  });

  httpServer = createServer(handler);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  try { rmSync(objDir, { recursive: true }); } catch {}
});

describe('http-server edge — /objects/:objectId HEAD vs GET (regression 2026-11-01)', () => {
  it('HEAD reaches the storage router: 200 with Content-Length and empty body', async () => {
    const res = await fetch(`${baseUrl}/objects/${OBJECT_ID}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(OBJECT_CONTENT)));
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(0);
  });

  it('GET still serves the full object (fix does not break GET)', async () => {
    const res = await fetch(`${baseUrl}/objects/${OBJECT_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(OBJECT_CONTENT);
  });

  it('HEAD of an unknown object is a router 404 (JSON), not the edge plain 404', async () => {
    const res = await fetch(`${baseUrl}/objects/obj_deadbeef000000`, { method: 'HEAD' });
    expect(res.status).toBe(404);
    // Router 404s are JSON; the edge's fall-through 404 carries no Content-Type.
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
  });
});
