/**
 * GET/HEAD /objects/:objectId — cache policy per endpoint (security F5,
 * review tn_KjOnSKdgygs1xbQu).
 *
 * Against a real MongoDB (MONGODB_URI, throwaway db): objects are put through
 * the real CallbackHandlers (file_object_put) and served through the route
 * factory with a fake request/response. Asserts the split policy: 200s keep
 * the 1-year immutable capability-URL cache (measured dependents: the app
 * viewer's HtmlPreview iframe, share-io file shares 302→this URL, the
 * viewer's "Open" button); every 4xx/5xx carries no-store so no shared proxy
 * heuristically caches a missing object.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'http';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { type Db, MongoClient } from 'mongodb';
import { CallbackHandlers } from '../../src/services/agent-apps/callback-handlers';
import { createAgentAppsStorageRoutes } from '../../src/routes/agent-apps-storage-routes';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = `teros_objects_cache_test_${Date.now()}`;
const OBJ_PATH = join(tmpdir(), `objects-cache-test-${Date.now()}`);

const INSTALL = 'app_objcache_1';

let client: MongoClient;
let db: Db;
let routes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>;

/** Call GET or HEAD on a path through the route factory; returns status, headers, body. */
async function callRoute(
  method: 'GET' | 'HEAD',
  path: string,
): Promise<{ handled: boolean; status: number; headers: Record<string, string>; body: string }> {
  const out = { status: 0, headers: {} as Record<string, string>, body: '' };
  const req = { method, headers: { host: 'localhost' } } as unknown as IncomingMessage;
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      out.status = status;
      out.headers = headers;
      return this;
    },
    end(body?: string | Buffer) {
      out.body = body ? String(body) : '';
    },
  } as unknown as ServerResponse;
  const handled = await routes(req, res, path);
  return { handled, ...out };
}

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  db = client.db(DB_NAME);
  const handlers = new CallbackHandlers({ db, objectStoragePath: OBJ_PATH });
  routes = createAgentAppsStorageRoutes({ db, callbackHandlers: handlers });
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
  await fs.rm(OBJ_PATH, { recursive: true, force: true });
});

async function putObject(contentType: string): Promise<string> {
  const res = await new CallbackHandlers({ db, objectStoragePath: OBJ_PATH }).handle({
    type: 'file_object_put',
    installationId: INSTALL,
    data: Buffer.from('hello f5').toString('base64'),
    contentType,
  } as any);
  if (!res.success) throw new Error(`file_object_put failed: ${JSON.stringify(res)}`);
  return (res as any).objectId as string;
}

describe('GET/HEAD /objects/:objectId — cache policy (security F5)', () => {
  it('[F5] a live object serves 200 with the 1-year immutable capability-URL cache — dependents measured (HtmlPreview iframe, share-io 302 target, Open button), content is never overwritten in place', async () => {
    const objectId = await putObject('text/plain');

    const get = await callRoute('GET', `/objects/${objectId}`);
    expect(get.handled).toBe(true);
    expect(get.status).toBe(200);
    // F1 routes the 200 through applyInlineSafetyHeaders, whose shared
    // withTextCharset rule appends charset=utf-8 to text/* types (same rule
    // as /media — RFC 9110 has no text/* default charset).
    expect(get.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(get.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(get.headers['X-Content-Type-Options']).toBe('nosniff');

    const head = await callRoute('HEAD', `/objects/${objectId}`);
    expect(head.status).toBe(200);
    expect(head.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
  });

  it('[F5] a missing object is a no-store 404 — never heuristically cached by shared proxies', async () => {
    const missing = await callRoute('GET', '/objects/obj_deadbeefdeadbeef');
    expect(missing.status).toBe(404);
    expect(missing.headers['Cache-Control']).toBe('no-store');
  });

  it('[F5] a malformed objectId is a no-store 404', async () => {
    const bad = await callRoute('GET', '/objects/not-an-object-id');
    expect(bad.status).toBe(404);
    expect(bad.headers['Cache-Control']).toBe('no-store');
  });

  it('[F5] the 404 after file_object_delete is no-store — deletion must not be masked by any cache', async () => {
    const objectId = await putObject('text/plain');
    expect((await callRoute('GET', `/objects/${objectId}`)).status).toBe(200);

    const del = await new CallbackHandlers({ db, objectStoragePath: OBJ_PATH }).handle({
      type: 'file_object_delete',
      installationId: INSTALL,
      objectId,
    } as any);
    expect(del.success).toBe(true);

    const gone = await callRoute('GET', `/objects/${objectId}`);
    expect(gone.status).toBe(404);
    expect(gone.headers['Cache-Control']).toBe('no-store');
  });
});

describe('GET/HEAD /objects/:objectId — inline containment headers (security F1)', () => {
  // The route factory derives frame-ancestors from the CORS allowlist; a
  // fixed one is injected here so the assertions are exact and hermetic.
  const FA = "frame-ancestors 'self' https://os.teros.ai";
  let f1Routes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>;

  beforeAll(async () => {
    const handlers = new CallbackHandlers({ db, objectStoragePath: OBJ_PATH });
    f1Routes = createAgentAppsStorageRoutes({
      db,
      callbackHandlers: handlers,
      security: { corsAllowedOrigins: ['https://os.teros.ai'] },
    });
  });

  /** GET a path through the F1 route instance. */
  async function getF1(path: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const out = { status: 0, headers: {} as Record<string, string>, body: '' };
    const req = { method: 'GET', headers: { host: 'localhost' } } as unknown as IncomingMessage;
    const res = {
      writeHead(status: number, headers: Record<string, string> = {}) {
        out.status = status;
        out.headers = headers;
        return this;
      },
      end(body?: string | Buffer) {
        out.body = body ? String(body) : '';
      },
    } as unknown as ServerResponse;
    await f1Routes(req, res, path);
    return out;
  }

  it('[F1] an HTML object serves 200 with CSP sandbox allow-scripts (NEVER allow-same-origin) + frame-ancestors + nosniff', async () => {
    const objectId = await putObject('text/html');
    const r = await getF1(`/objects/${objectId}`);
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(r.headers['Content-Security-Policy']).toBe(`sandbox allow-scripts; ${FA}`);
    expect(r.headers['Content-Security-Policy']).not.toContain('allow-same-origin');
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
    // F5 cache policy untouched by F1
    expect(r.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
  });

  it('[F1] an SVG object gets the sandbox CSP too (the other browser-executable type)', async () => {
    const objectId = await putObject('image/svg+xml');
    const r = await getF1(`/objects/${objectId}`);
    expect(r.status).toBe(200);
    expect(r.headers['Content-Security-Policy']).toBe(`sandbox allow-scripts; ${FA}`);
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('[F1] a PNG object gets NO CSP but DOES get nosniff — images cannot execute', async () => {
    const objectId = await putObject('image/png');
    const r = await getF1(`/objects/${objectId}`);
    expect(r.status).toBe(200);
    expect(r.headers['Content-Security-Policy']).toBeUndefined();
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('[F1] a PDF and a text/markdown object get nosniff only (benign renderable types)', async () => {
    for (const t of ['application/pdf', 'text/markdown']) {
      const objectId = await putObject(t);
      const r = await getF1(`/objects/${objectId}`);
      expect(r.status).toBe(200);
      expect(r.headers['Content-Security-Policy']).toBeUndefined();
      expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
    }
  });

  it('[F1] the 404s (missing + malformed id) carry nosniff — no response of this route is sniffable', async () => {
    const missing = await getF1('/objects/obj_deadbeefdeadbeef');
    expect(missing.status).toBe(404);
    expect(missing.headers['X-Content-Type-Options']).toBe('nosniff');

    const bad = await getF1('/objects/not-an-object-id');
    expect(bad.status).toBe(404);
    expect(bad.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('[F1] HEAD on an HTML object carries the same CSP — headers must not depend on the body', async () => {
    const objectId = await putObject('text/html');
    const out = { status: 0, headers: {} as Record<string, string> };
    const req = { method: 'HEAD', headers: { host: 'localhost' } } as unknown as IncomingMessage;
    const res = {
      writeHead(status: number, headers: Record<string, string> = {}) {
        out.status = status;
        out.headers = headers;
        return this;
      },
      end() {},
    } as unknown as ServerResponse;
    await f1Routes(req, res, `/objects/${objectId}`);
    expect(out.status).toBe(200);
    expect(out.headers['Content-Security-Policy']).toBe(`sandbox allow-scripts; ${FA}`);
    expect(out.headers['X-Content-Type-Options']).toBe('nosniff');
  });
});
