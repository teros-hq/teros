/**
 * Integration tests — AgentApps storage HTTP endpoints (standalone)
 *
 * Verifies that the standalone storage routes work correctly WITHOUT
 * AGENT_APPS_ENABLED=true. The routes wrap CallbackHandlers as HTTP
 * endpoints and only need a Db connection + objectStoragePath, plus a
 * container manager to verify the per-MCA callback token (P0a auth — faked here).
 *
 * Covers:
 *   1. Document Store  — put / get / query / update / delete
 *   2. Object Storage   — put / get / list / GET public serve / delete
 *   3. Isolation        — installationId scoping (docs + objects)
 *   4. Limits           — document > 1MB rejected, object > 50MB rejected
 *   5. Lifecycle        — install / uninstall + object cleanup
 *
 * The test spins up a real HTTP server with createAgentAppsStorageRoutes
 * wired in, then uses fetch() to exercise the endpoints end-to-end.
 * No McaManager or AgentAppsBridge is required.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import { createServer, type Server } from 'http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  createAgentAppsStorageRoutes,
  ensureAgentAppsStorageIndexes,
} from '../../src/routes/agent-apps-storage-routes';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27019';
const DB_NAME = `teros_test_agent_apps_storage_${Date.now()}`;
const OBJ_DIR = mkdtempSync(join(tmpdir(), 'agent-apps-storage-test-'));

let mongoClient: MongoClient;
let db: Db;
let httpServer: Server;
let baseUrl: string;
let available = false;

// Fake container manager for the callback-token auth (authenticateCallback).
const TEST_MCA_ID = 'mca.test.agent-apps-storage';
const TEST_WORKSPACE_ID = 'work-test';
const INSTALLATION_IDS = ['test-inst', 'inst-A', 'inst-B', 'inst-life-1', 'inst-life-2', 'inst-index-test'];
const tokenFor = (appId: string) => `test-token-${appId}`;
const fakeContainerManager = {
  verifyCallbackToken: (key: string, token: string) => token === tokenFor(key),
  getInfo: () => ({ mcaId: TEST_MCA_ID }),
} as any;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function postJson(path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  // The surface is authenticated (P0a): act as the app named by the body's
  // installationId, with that app's per-MCA callback token. The server derives
  // the scope from the verified token, not from the body.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (typeof body.installationId === 'string') {
    headers['Authorization'] = `Bearer ${tokenFor(body.installationId)}`;
    headers['X-App-Id'] = body.installationId;
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function getRaw(path: string): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'GET' });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body: buf };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    mongoClient = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 });
    db = mongoClient.db(DB_NAME);
    available = true;
  } catch {
    console.warn('[agent-apps-storage test] Mongo unreachable — skipping');
    return;
  }

  // Ensure indexes (same as bootstrap does)
  await ensureAgentAppsStorageIndexes(db);

  // One app per installation, owned by the test workspace and bound to the
  // token's mcaId — the route only honours X-App-Id for apps of that MCA.
  await db.collection('apps').insertMany(
    INSTALLATION_IDS.map((appId) => ({ appId, mcaId: TEST_MCA_ID, ownerId: TEST_WORKSPACE_ID })),
  );

  // Create the storage routes handler
  const handler = createAgentAppsStorageRoutes({
    db,
    objectStoragePath: OBJ_DIR,
    containerManager: fakeContainerManager,
  });

  // Spin up a real HTTP server
  httpServer = createServer(async (req, res) => {
    const url = req.url || '/';
    // Delegate to the storage routes handler
    const handled = await handler(req, res, url);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
  if (mongoClient) {
    await mongoClient.db(DB_NAME).dropDatabase();
    await mongoClient.close();
  }
  try { rmSync(OBJ_DIR, { recursive: true }); } catch {}
});

beforeEach(async () => {
  if (!available) return;
  // Clean up any test data from previous runs
  await cleanupCollections();
});

afterEach(async () => {
  if (!available) return;
  await cleanupCollections();
});

async function cleanupCollections() {
  // Drop any dynamically-created storage collections
  const collections = await db.listCollections({ name: /^agent_app_storage_/ }).toArray();
  for (const col of collections) {
    await db.collection(col.name).drop();
  }
  // Clean up installations + objects
  await db.collection('agent_app_installations').deleteMany({});
  await db.collection('agent_app_objects').deleteMany({});
}

// ---------------------------------------------------------------------------
// 1. Document Store
// ---------------------------------------------------------------------------

describe('AgentApps Storage — Document Store', () => {
  beforeEach(async () => {
    if (!available) return;
    await cleanupCollections();
  });

  it('PUT creates a document and returns success', async () => {
    const { status, body } = await postJson('/api/agent-apps/storage/put', {
      installationId: 'test-inst',
      collection: 'settings',
      documentId: 'doc1',
      document: { theme: 'dark' },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.documentId).toBe('doc1');
  });

  it('GET retrieves the document that was PUT', async () => {
    await postJson('/api/agent-apps/storage/put', {
      installationId: 'test-inst',
      collection: 'settings',
      documentId: 'doc1',
      document: { theme: 'dark' },
    });

    const { status, body } = await postJson('/api/agent-apps/storage/get', {
      installationId: 'test-inst',
      collection: 'settings',
      documentId: 'doc1',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.document).not.toBeNull();
    expect(body.document.theme).toBe('dark');
  });

  it('GET returns null for non-existent document', async () => {
    const { status, body } = await postJson('/api/agent-apps/storage/get', {
      installationId: 'test-inst',
      collection: 'settings',
      documentId: 'nope',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.document).toBeNull();
  });

  it('QUERY returns matching documents', async () => {
    await postJson('/api/agent-apps/storage/put', {
      installationId: 'test-inst',
      collection: 'settings',
      documentId: 'doc1',
      document: { theme: 'dark' },
    });
    await postJson('/api/agent-apps/storage/put', {
      installationId: 'test-inst',
      collection: 'settings',
      documentId: 'doc2',
      document: { theme: 'light' },
    });

    const { status, body } = await postJson('/api/agent-apps/storage/query', {
      installationId: 'test-inst',
      collection: 'settings',
      filter: { theme: 'dark' },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.documents)).toBe(true);
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].theme).toBe('dark');
  });

  it('UPDATE patches an existing document', async () => {
    await postJson('/api/agent-apps/storage/put', {
      installationId: 'test-inst',
      collection: 'settings',
      documentId: 'doc1',
      document: { theme: 'dark' },
    });

    const { status, body } = await postJson('/api/agent-apps/storage/update', {
      installationId: 'test-inst',
      collection: 'settings',
      documentId: 'doc1',
      patch: { theme: 'light' },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.document.theme).toBe('light');
  });

  it('DELETE removes a document', async () => {
    await postJson('/api/agent-apps/storage/put', {
      installationId: 'test-inst',
      collection: 'settings',
      documentId: 'doc1',
      document: { theme: 'dark' },
    });

    const { status, body } = await postJson('/api/agent-apps/storage/delete', {
      installationId: 'test-inst',
      collection: 'settings',
      documentId: 'doc1',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // Verify it's gone
    const getRes = await postJson('/api/agent-apps/storage/get', {
      installationId: 'test-inst',
      collection: 'settings',
      documentId: 'doc1',
    });
    expect(getRes.body.document).toBeNull();
  });

  it('rejects invalid JSON body with 400', async () => {
    const res = await fetch(`${baseUrl}/api/agent-apps/storage/put`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain('Invalid JSON');
  });

  it('returns success=false for missing required fields (handler catches error)', async () => {
    // isCallbackRequest only validates the `type` field, so the request passes
    // route-level validation. The handler then crashes on missing fields and
    // returns success=false via its catch block.
    const { status, body } = await postJson('/api/agent-apps/storage/put', {
      installationId: 'test-inst',
      // missing collection, documentId, document
    });
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Object Storage
// ---------------------------------------------------------------------------

describe('AgentApps Storage — Object Storage', () => {
  beforeEach(async () => {
    if (!available) return;
    await cleanupCollections();
  });

  it('PUT stores an object and returns objectId + url', async () => {
    const data = Buffer.from('hello').toString('base64');
    const { status, body } = await postJson('/api/agent-apps/objects/put', {
      installationId: 'test-inst',
      data,
      contentType: 'text/plain',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.objectId).toMatch(/^obj_[a-f0-9]+$/);
    expect(body.url).toContain('/objects/');
  });

  it('GET retrieves the object data by objectId', async () => {
    const data = Buffer.from('hello').toString('base64');
    const putRes = await postJson('/api/agent-apps/objects/put', {
      installationId: 'test-inst',
      data,
      contentType: 'text/plain',
    });
    const objectId = putRes.body.objectId;

    const { status, body } = await postJson('/api/agent-apps/objects/get', {
      installationId: 'test-inst',
      objectId,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toBe(data);
    expect(body.contentType).toBe('text/plain');
  });

  it('GET returns null data for non-existent objectId', async () => {
    const { status, body } = await postJson('/api/agent-apps/objects/get', {
      installationId: 'test-inst',
      objectId: 'obj_nonexistent1234',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toBeNull();
  });

  it('LIST returns stored objects with objectId', async () => {
    const data = Buffer.from('hello').toString('base64');
    await postJson('/api/agent-apps/objects/put', {
      installationId: 'test-inst',
      data,
      contentType: 'text/plain',
    });

    const { status, body } = await postJson('/api/agent-apps/objects/list', {
      installationId: 'test-inst',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.objects)).toBe(true);
    expect(body.objects.length).toBeGreaterThanOrEqual(1);
    expect(body.objects[0].objectId).toMatch(/^obj_[a-f0-9]+$/);
  });

  it('GET /objects/:objectId serves the file publicly (no auth)', async () => {
    const data = Buffer.from('hello').toString('base64');
    const putRes = await postJson('/api/agent-apps/objects/put', {
      installationId: 'test-inst',
      data,
      contentType: 'text/plain',
    });
    const objectId = putRes.body.objectId;

    // Fetch the public URL — no token, no auth header
    const { status, headers, body } = await getRaw(`/objects/${objectId}`);
    expect(status).toBe(200);
    // F1 (content-safety): text/* responses always carry an explicit charset
    expect(headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(body.toString()).toBe('hello');
    // Immutable cache headers
    expect(headers.get('cache-control')).toContain('immutable');
  });

  it('GET /objects/:objectId returns 404 for non-existent object', async () => {
    const { status } = await getRaw('/objects/obj_nonexistent1234');
    expect(status).toBe(404);
  });

  it('GET /objects/:objectId returns 404 for invalid objectId format', async () => {
    const { status } = await getRaw('/objects/not-an-object-id');
    expect(status).toBe(404);
  });

  it('DELETE removes an object by objectId', async () => {
    const data = Buffer.from('hello').toString('base64');
    const putRes = await postJson('/api/agent-apps/objects/put', {
      installationId: 'test-inst',
      data,
      contentType: 'text/plain',
    });
    const objectId = putRes.body.objectId;

    const { status, body } = await postJson('/api/agent-apps/objects/delete', {
      installationId: 'test-inst',
      objectId,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // Verify it's gone
    const getRes = await postJson('/api/agent-apps/objects/get', {
      installationId: 'test-inst',
      objectId,
    });
    expect(getRes.body.data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Isolation (installationId scoping)
// ---------------------------------------------------------------------------

describe('AgentApps Storage — Isolation', () => {
  beforeEach(async () => {
    if (!available) return;
    await cleanupCollections();
  });

  it('document store is isolated by installationId', async () => {
    // PUT with inst-A
    await postJson('/api/agent-apps/storage/put', {
      installationId: 'inst-A',
      collection: 'settings',
      documentId: 'doc1',
      document: { theme: 'dark' },
    });

    // GET with inst-B → should be null
    const { status, body } = await postJson('/api/agent-apps/storage/get', {
      installationId: 'inst-B',
      collection: 'settings',
      documentId: 'doc1',
    });
    expect(status).toBe(200);
    expect(body.document).toBeNull();
  });

  it('object storage is isolated by installationId', async () => {
    // PUT with inst-A
    const putRes = await postJson('/api/agent-apps/objects/put', {
      installationId: 'inst-A',
      data: Buffer.from('secret').toString('base64'),
      contentType: 'text/plain',
    });
    const objectId = putRes.body.objectId;

    // GET with inst-B → should be null (different installation)
    const { status, body } = await postJson('/api/agent-apps/objects/get', {
      installationId: 'inst-B',
      objectId,
    });
    expect(status).toBe(200);
    expect(body.data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Limits
// ---------------------------------------------------------------------------

describe('AgentApps Storage — Limits', () => {
  beforeEach(async () => {
    if (!available) return;
    await cleanupCollections();
  });

  it('rejects document larger than 1MB', async () => {
    // Generate a document > 1MB (1,048,576 bytes)
    // JSON.stringify adds quotes and keys, so we need the value itself to be > 1MB
    const bigValue = 'x'.repeat(1024 * 1024 + 100);
    const { status, body } = await postJson('/api/agent-apps/storage/put', {
      installationId: 'test-inst',
      collection: 'settings',
      documentId: 'big-doc',
      document: { data: bigValue },
    });
    expect(status).toBe(200); // The route always returns 200, but success=false
    expect(body.success).toBe(false);
    expect(body.error).toContain('too large');
  });

  it('rejects object larger than 50MB', async () => {
    // Generate a base64 blob > 50MB
    // 50MB = 52,428,800 bytes. We need the decoded buffer to exceed this.
    // base64 encoding inflates by ~33%, so we need ~70MB of base64 to get >50MB decoded.
    // That's a lot of memory — instead, let's test with a smaller limit by using
    // a CallbackHandlers with a small maxObjectSize.
    //
    // Actually, the default maxObjectSize is 50MB. Creating a 50MB+ base64 string
    // in memory is feasible but slow. Let's create exactly 51MB of raw data.
    const rawSize = 51 * 1024 * 1024; // 51MB
    const bigData = Buffer.alloc(rawSize, 0x41).toString('base64');

    const { status, body } = await postJson('/api/agent-apps/objects/put', {
      installationId: 'test-inst',
      data: bigData,
      contentType: 'application/octet-stream',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toContain('too large');
  });
});

// ---------------------------------------------------------------------------
// 5. Lifecycle
// ---------------------------------------------------------------------------

describe('AgentApps Storage — Lifecycle', () => {
  beforeEach(async () => {
    if (!available) return;
    await cleanupCollections();
  });

  it('INSTALL records the installation in agent_app_installations', async () => {
    const { status, body } = await postJson('/api/agent-apps/lifecycle/install', {
      installationId: 'inst-life-1',
      workspaceId: 'work-test',
      userId: 'user-test',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // Verify it was recorded in MongoDB
    const doc = await db.collection('agent_app_installations').findOne({
      installationId: 'inst-life-1',
    });
    expect(doc).not.toBeNull();
    expect(doc?.status).toBe('installed');
    expect(doc?.workspaceId).toBe('work-test');
  });

  it('UNINSTALL marks as uninstalled and cleans up object storage', async () => {
    // Install first
    await postJson('/api/agent-apps/lifecycle/install', {
      installationId: 'inst-life-2',
      workspaceId: 'work-test',
    });

    // Put an object in storage
    const putRes = await postJson('/api/agent-apps/objects/put', {
      installationId: 'inst-life-2',
      data: Buffer.from('temp data').toString('base64'),
      contentType: 'text/plain',
    });
    const objectId = putRes.body.objectId;

    // Verify the object exists
    const beforeGet = await postJson('/api/agent-apps/objects/get', {
      installationId: 'inst-life-2',
      objectId,
    });
    expect(beforeGet.body.data).not.toBeNull();

    // Uninstall
    const { status, body } = await postJson('/api/agent-apps/lifecycle/uninstall', {
      installationId: 'inst-life-2',
      workspaceId: 'work-test',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // Verify installation is marked as uninstalled
    const doc = await db.collection('agent_app_installations').findOne({
      installationId: 'inst-life-2',
    });
    expect(doc?.status).toBe('uninstalled');
    expect(doc?.uninstalledAt).toBeDefined();

    // Verify object storage was cleaned up (file deleted from disk)
    const afterGet = await postJson('/api/agent-apps/objects/get', {
      installationId: 'inst-life-2',
      objectId,
    });
    expect(afterGet.body.data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Index verification
// ---------------------------------------------------------------------------

describe('AgentApps storage indexes', () => {
  beforeEach(() => {
    if (!available) return;
  });

  it('agent_app_installations has unique index on installationId', async () => {
    if (!available) return;
    const indexes = await db.collection('agent_app_installations').indexes();
    const idx = indexes.find(i => i.key && i.key.installationId === 1);
    expect(idx).toBeDefined();
    expect(idx!.unique).toBe(true);
  });

  it('agent_app_installations has index on workspaceId', async () => {
    if (!available) return;
    const indexes = await db.collection('agent_app_installations').indexes();
    const idx = indexes.find(i => i.key && i.key.workspaceId === 1);
    expect(idx).toBeDefined();
  });

  it('agent_app_installations has index on status', async () => {
    if (!available) return;
    const indexes = await db.collection('agent_app_installations').indexes();
    const idx = indexes.find(i => i.key && i.key.status === 1);
    expect(idx).toBeDefined();
  });

  it('agent_app_objects has unique index on objectId', async () => {
    if (!available) return;
    const indexes = await db.collection('agent_app_objects').indexes();
    const idx = indexes.find(i => i.key && i.key.objectId === 1);
    expect(idx).toBeDefined();
    expect(idx!.unique).toBe(true);
  });

  it('agent_app_objects has index on installationId', async () => {
    if (!available) return;
    const indexes = await db.collection('agent_app_objects').indexes();
    const idx = indexes.find(
      i => i.key && i.key.installationId === 1 && i.key.objectId === undefined,
    );
    expect(idx).toBeDefined();
  });

  it('dynamic collection gets _installationId + _documentId unique index on first put', async () => {
    if (!available) return;
    // Use a unique collection name for this test
    const testCollection = 'index_test_' + Date.now();

    // Put a document — this should trigger ensureDynamicCollectionIndexes
    const { status, body } = await postJson('/api/agent-apps/storage/put', {
      installationId: 'inst-index-test',
      collection: testCollection,
      documentId: 'doc1',
      document: { hello: 'world' },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // Verify the indexes were created
    const fullCollectionName = `agent_app_storage_${testCollection}`;
    const indexes = await db.collection(fullCollectionName).indexes();

    // Unique compound index on _installationId + _documentId
    const compoundIdx = indexes.find(
      i => i.key && i.key._installationId === 1 && i.key._documentId === 1,
    );
    expect(compoundIdx).toBeDefined();
    expect(compoundIdx!.unique).toBe(true);

    // Index on _installationId
    const instIdx = indexes.find(i => i.key && i.key._installationId === 1 && i.key._documentId === undefined);
    expect(instIdx).toBeDefined();
  });
});
