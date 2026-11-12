import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Db, MongoClient } from 'mongodb';
import { CallbackHandlers } from '../../src/services/agent-apps/callback-handlers';
import type {
  StoragePutRequest,
  StorageGetRequest,
  StorageQueryRequest,
  StorageUpdateRequest,
  StorageDeleteRequest,
  FileObjectPutRequest,
  FileObjectGetRequest,
  FileObjectDeleteRequest,
  FileObjectListRequest,
  FileVolumeWriteFileRequest,
  FileVolumeReadFileRequest,
  FileVolumeReadDirRequest,
  FileVolumeStatRequest,
  FileVolumeDeleteRequest,
  LifecycleInstallRequest,
  LifecycleUninstallRequest,
} from '../../src/services/agent-apps/types';
import {
  isCallbackRequest,
  isStorageCallbackRequest,
  isFileCallbackRequest,
  isLifecycleCallbackRequest,
} from '../../src/services/agent-apps/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_DB_NAME = `teros_test_agent_apps_${Date.now()}`;
const TEST_OBJ_PATH = join(tmpdir(), `agent-apps-test-${Date.now()}`);
const TEST_VOLUME_PATH = join(tmpdir(), `agent-apps-vol-${Date.now()}`);

let mongoClient: MongoClient;
let db: Db;

beforeEach(async () => {
  mongoClient = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017');
  await mongoClient.connect();
  db = mongoClient.db(TEST_DB_NAME);

  // Create a test workspace + volume for volume storage tests
  await db.collection('workspaces').insertOne({
    workspaceId: 'work_test_001',
    volumeId: 'vol_test_001',
    name: 'Test Workspace',
  });
  await db.collection('volumes').insertOne({
    volumeId: 'vol_test_001',
    hostPath: TEST_VOLUME_PATH,
    name: 'Test Volume',
  });
  await fs.mkdir(TEST_VOLUME_PATH, { recursive: true });
  await fs.mkdir(TEST_OBJ_PATH, { recursive: true });
});

afterEach(async () => {
  await mongoClient.db(TEST_DB_NAME).dropDatabase();
  await mongoClient.close();
  try { await fs.rm(TEST_OBJ_PATH, { recursive: true }); } catch {}
  try { await fs.rm(TEST_VOLUME_PATH, { recursive: true }); } catch {}
});

function createHandlers(): CallbackHandlers {
  return new CallbackHandlers({
    db,
    objectStoragePath: TEST_OBJ_PATH,
  });
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

describe('Callback type guards', () => {
  it('isCallbackRequest identifies storage requests', () => {
    expect(isCallbackRequest({ type: 'storage_put', installationId: 'i1', collection: 'todos', documentId: 'd1', document: {} })).toBe(true);
    expect(isCallbackRequest({ type: 'storage_get', installationId: 'i1', collection: 'todos', documentId: 'd1' })).toBe(true);
    expect(isCallbackRequest({ type: 'unknown_thing', installationId: 'i1' })).toBe(false);
    expect(isCallbackRequest(null)).toBe(false);
    expect(isCallbackRequest('string')).toBe(false);
  });

  it('isCallbackRequest identifies file requests', () => {
    expect(isCallbackRequest({ type: 'file_object_put', installationId: 'i1', data: '' })).toBe(true);
    expect(isCallbackRequest({ type: 'file_volume_read_file', installationId: 'i1', workspaceId: 'w', path: '/p' })).toBe(true);
  });

  it('isCallbackRequest identifies lifecycle requests', () => {
    expect(isCallbackRequest({ type: 'lifecycle_install', installationId: 'i1' })).toBe(true);
    expect(isCallbackRequest({ type: 'lifecycle_uninstall', installationId: 'i1' })).toBe(true);
  });

  it('isStorageCallbackRequest narrows correctly', () => {
    expect(isStorageCallbackRequest({ type: 'storage_put', installationId: 'i1', collection: 'c', documentId: 'd', document: {} })).toBe(true);
    expect(isStorageCallbackRequest({ type: 'file_object_put', installationId: 'i1' })).toBe(false);
  });

  it('isFileCallbackRequest narrows correctly', () => {
    expect(isFileCallbackRequest({ type: 'file_object_put', installationId: 'i1' })).toBe(true);
    expect(isFileCallbackRequest({ type: 'storage_put', installationId: 'i1' })).toBe(false);
  });

  it('isLifecycleCallbackRequest narrows correctly', () => {
    expect(isLifecycleCallbackRequest({ type: 'lifecycle_install', installationId: 'i1' })).toBe(true);
    expect(isLifecycleCallbackRequest({ type: 'storage_put', installationId: 'i1' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Document Store (storage_put/get/query/update/delete)
// ---------------------------------------------------------------------------

describe('CallbackHandlers — Document Store', () => {
  it('storage_put creates a document', async () => {
    const handlers = createHandlers();
    const req: StoragePutRequest = {
      type: 'storage_put',
      installationId: 'inst_001',
      collection: 'todos',
      documentId: 'todo_1',
      document: { title: 'Buy milk', completed: false },
    };
    const res = await handlers.handle(req);
    expect(res.success).toBe(true);
    expect((res as any).documentId).toBe('todo_1');
  });

  it('storage_get retrieves a document', async () => {
    const handlers = createHandlers();
    await handlers.handle({
      type: 'storage_put',
      installationId: 'inst_002',
      collection: 'todos',
      documentId: 'todo_2',
      document: { title: 'Buy eggs', completed: false },
    });
    const res = await handlers.handle({
      type: 'storage_get',
      installationId: 'inst_002',
      collection: 'todos',
      documentId: 'todo_2',
    } as StorageGetRequest);
    expect(res.success).toBe(true);
    expect((res as any).document).not.toBeNull();
    expect((res as any).document.title).toBe('Buy eggs');
  });

  it('storage_get returns null for non-existent document', async () => {
    const handlers = createHandlers();
    const res = await handlers.handle({
      type: 'storage_get',
      installationId: 'inst_003',
      collection: 'todos',
      documentId: 'nonexistent',
    } as StorageGetRequest);
    expect(res.success).toBe(true);
    expect((res as any).document).toBeNull();
  });

  it('storage_put is isolated by installationId', async () => {
    const handlers = createHandlers();
    await handlers.handle({
      type: 'storage_put',
      installationId: 'inst_a',
      collection: 'todos',
      documentId: 'todo_1',
      document: { title: 'A' },
    } as StoragePutRequest);
    const res = await handlers.handle({
      type: 'storage_get',
      installationId: 'inst_b',
      collection: 'todos',
      documentId: 'todo_1',
    } as StorageGetRequest);
    expect((res as any).document).toBeNull();
  });

  it('storage_query returns matching documents', async () => {
    const handlers = createHandlers();
    for (let i = 0; i < 5; i++) {
      await handlers.handle({
        type: 'storage_put',
        installationId: 'inst_q',
        collection: 'todos',
        documentId: `todo_${i}`,
        document: { title: `Task ${i}`, completed: i % 2 === 0 },
      } as StoragePutRequest);
    }
    const res = await handlers.handle({
      type: 'storage_query',
      installationId: 'inst_q',
      collection: 'todos',
      filter: { completed: true },
    } as StorageQueryRequest);
    expect(res.success).toBe(true);
    expect((res as any).documents).toHaveLength(3);
  });

  it('storage_query respects limit and cursor', async () => {
    const handlers = createHandlers();
    for (let i = 0; i < 10; i++) {
      await handlers.handle({
        type: 'storage_put',
        installationId: 'inst_p',
        collection: 'todos',
        documentId: `todo_${i}`,
        document: { title: `Task ${i}` },
      } as StoragePutRequest);
    }
    const res1 = await handlers.handle({
      type: 'storage_query',
      installationId: 'inst_p',
      collection: 'todos',
      limit: 3,
    } as StorageQueryRequest);
    expect(res1.success).toBe(true);
    expect((res1 as any).documents).toHaveLength(3);
    expect((res1 as any).nextCursor).toBeDefined();

    const res2 = await handlers.handle({
      type: 'storage_query',
      installationId: 'inst_p',
      collection: 'todos',
      limit: 3,
      cursor: (res1 as any).nextCursor,
    } as StorageQueryRequest);
    expect(res2.success).toBe(true);
    expect((res2 as any).documents).toHaveLength(3);
  });

  it('storage_update patches an existing document', async () => {
    const handlers = createHandlers();
    await handlers.handle({
      type: 'storage_put',
      installationId: 'inst_u',
      collection: 'todos',
      documentId: 'todo_1',
      document: { title: 'Original', completed: false },
    } as StoragePutRequest);
    const res = await handlers.handle({
      type: 'storage_update',
      installationId: 'inst_u',
      collection: 'todos',
      documentId: 'todo_1',
      patch: { completed: true },
    } as StorageUpdateRequest);
    expect(res.success).toBe(true);
    expect((res as any).document.completed).toBe(true);
    expect((res as any).document.title).toBe('Original');
  });

  it('storage_update returns error for non-existent document', async () => {
    const handlers = createHandlers();
    const res = await handlers.handle({
      type: 'storage_update',
      installationId: 'inst_u',
      collection: 'todos',
      documentId: 'nonexistent',
      patch: { completed: true },
    } as StorageUpdateRequest);
    expect(res.success).toBe(false);
    expect((res as any).error).toContain('not found');
  });

  it('storage_delete removes a document', async () => {
    const handlers = createHandlers();
    await handlers.handle({
      type: 'storage_put',
      installationId: 'inst_d',
      collection: 'todos',
      documentId: 'todo_1',
      document: { title: 'To delete' },
    } as StoragePutRequest);
    const res = await handlers.handle({
      type: 'storage_delete',
      installationId: 'inst_d',
      collection: 'todos',
      documentId: 'todo_1',
    } as StorageDeleteRequest);
    expect(res.success).toBe(true);

    const getRes = await handlers.handle({
      type: 'storage_get',
      installationId: 'inst_d',
      collection: 'todos',
      documentId: 'todo_1',
    } as StorageGetRequest);
    expect((getRes as any).document).toBeNull();
  });

  it('rejects invalid collection names', async () => {
    const handlers = createHandlers();
    const res = await handlers.handle({
      type: 'storage_put',
      installationId: 'inst_x',
      collection: 'bad name!',
      documentId: 'd1',
      document: {},
    } as StoragePutRequest);
    expect(res.success).toBe(false);
    expect((res as any).error).toContain('Invalid collection name');
  });
});

// ---------------------------------------------------------------------------
// Object Storage (file_object_put/get/delete/list — objectId-based blob store)
// ---------------------------------------------------------------------------

describe('CallbackHandlers — Object Storage', () => {
  it('file_object_put stores data and returns objectId + url', async () => {
    const handlers = createHandlers();
    const data = Buffer.from('Hello, World!').toString('base64');
    const res = await handlers.handle({
      type: 'file_object_put',
      installationId: 'inst_obj_1',
      data,
      contentType: 'text/plain',
    } as FileObjectPutRequest);
    expect(res.success).toBe(true);
    expect((res as any).objectId).toMatch(/^obj_[a-f0-9]+$/);
    expect((res as any).url).toContain('/objects/');
  });

  it('file_object_get retrieves data by objectId', async () => {
    const handlers = createHandlers();
    const data = Buffer.from('Hello, Object Storage!').toString('base64');
    const putRes = await handlers.handle({
      type: 'file_object_put',
      installationId: 'inst_obj_2',
      data,
      contentType: 'text/plain',
    } as FileObjectPutRequest);
    const objectId = (putRes as any).objectId;
    const res = await handlers.handle({
      type: 'file_object_get',
      installationId: 'inst_obj_2',
      objectId,
    } as FileObjectGetRequest);
    expect(res.success).toBe(true);
    expect((res as any).data).toBe(data);
    expect((res as any).contentType).toBe('text/plain');
  });

  it('file_object_get returns null for non-existent objectId', async () => {
    const handlers = createHandlers();
    const res = await handlers.handle({
      type: 'file_object_get',
      installationId: 'inst_obj_3',
      objectId: 'obj_nonexistent1234',
    } as FileObjectGetRequest);
    expect(res.success).toBe(true);
    expect((res as any).data).toBeNull();
  });

  it('file_object_delete removes an object by objectId', async () => {
    const handlers = createHandlers();
    const putRes = await handlers.handle({
      type: 'file_object_put',
      installationId: 'inst_obj_4',
      data: Buffer.from('temp').toString('base64'),
    } as FileObjectPutRequest);
    const objectId = (putRes as any).objectId;
    const res = await handlers.handle({
      type: 'file_object_delete',
      installationId: 'inst_obj_4',
      objectId,
    } as FileObjectDeleteRequest);
    expect(res.success).toBe(true);

    const getRes = await handlers.handle({
      type: 'file_object_get',
      installationId: 'inst_obj_4',
      objectId,
    } as FileObjectGetRequest);
    expect((getRes as any).data).toBeNull();
  });

  it('file_object_list returns stored objects with objectId', async () => {
    const handlers = createHandlers();
    for (let i = 0; i < 3; i++) {
      await handlers.handle({
        type: 'file_object_put',
        installationId: 'inst_obj_5',
        data: Buffer.from(`content ${i}`).toString('base64'),
      } as FileObjectPutRequest);
    }
    const res = await handlers.handle({
      type: 'file_object_list',
      installationId: 'inst_obj_5',
    } as FileObjectListRequest);
    expect(res.success).toBe(true);
    expect((res as any).objects).toHaveLength(3);
    expect((res as any).objects.every((o: any) => o.objectId.startsWith('obj_'))).toBe(true);
  });

  it('object storage is isolated by installationId', async () => {
    const handlers = createHandlers();
    await handlers.handle({
      type: 'file_object_put',
      installationId: 'inst_iso_a',
      key: 'secret.txt',
      data: Buffer.from('secret').toString('base64'),
    } as FileObjectPutRequest);
    const res = await handlers.handle({
      type: 'file_object_get',
      installationId: 'inst_iso_b',
      key: 'secret.txt',
    } as FileObjectGetRequest);
    expect((res as any).data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Volume Storage (file_volume_readDir/readFile/writeFile/delete/stat)
// ---------------------------------------------------------------------------

describe('CallbackHandlers — Volume Storage', () => {
  it('file_volume_write_file creates a file in the workspace volume', async () => {
    const handlers = createHandlers();
    const res = await handlers.handle({
      type: 'file_volume_write_file',
      installationId: 'inst_vol_1',
      workspaceId: 'work_test_001',
      path: 'test.txt',
      data: Buffer.from('Volume file content').toString('base64'),
    } as FileVolumeWriteFileRequest);
    expect(res.success).toBe(true);

    // Verify the file exists on the host
    const content = await fs.readFile(join(TEST_VOLUME_PATH, 'test.txt'), 'utf8');
    expect(content).toBe('Volume file content');
  });

  it('file_volume_read_file reads a file from the workspace volume', async () => {
    const handlers = createHandlers();
    await fs.writeFile(join(TEST_VOLUME_PATH, 'readme.md'), '# Hello Volume');
    const res = await handlers.handle({
      type: 'file_volume_read_file',
      installationId: 'inst_vol_2',
      workspaceId: 'work_test_001',
      path: 'readme.md',
    } as FileVolumeReadFileRequest);
    expect(res.success).toBe(true);
    const decoded = Buffer.from((res as any).data, 'base64').toString('utf8');
    expect(decoded).toBe('# Hello Volume');
  });

  it('file_volume_read_file returns null for non-existent file', async () => {
    const handlers = createHandlers();
    const res = await handlers.handle({
      type: 'file_volume_read_file',
      installationId: 'inst_vol_3',
      workspaceId: 'work_test_001',
      path: 'nonexistent.txt',
    } as FileVolumeReadFileRequest);
    expect(res.success).toBe(true);
    expect((res as any).data).toBeNull();
  });

  it('file_volume_read_dir lists directory entries', async () => {
    const handlers = createHandlers();
    await fs.writeFile(join(TEST_VOLUME_PATH, 'a.txt'), 'A');
    await fs.writeFile(join(TEST_VOLUME_PATH, 'b.txt'), 'B');
    await fs.mkdir(join(TEST_VOLUME_PATH, 'subdir'), { recursive: true });
    const res = await handlers.handle({
      type: 'file_volume_read_dir',
      installationId: 'inst_vol_4',
      workspaceId: 'work_test_001',
      path: '',
    } as FileVolumeReadDirRequest);
    expect(res.success).toBe(true);
    const entries = (res as any).entries;
    expect(entries).toHaveLength(3);
    const names = entries.map((e: any) => e.name).sort();
    expect(names).toEqual(['a.txt', 'b.txt', 'subdir']);
  });

  it('file_volume_stat returns file metadata', async () => {
    const handlers = createHandlers();
    await fs.writeFile(join(TEST_VOLUME_PATH, 'stat.txt'), 'content');
    const res = await handlers.handle({
      type: 'file_volume_stat',
      installationId: 'inst_vol_5',
      workspaceId: 'work_test_001',
      path: 'stat.txt',
    } as FileVolumeStatRequest);
    expect(res.success).toBe(true);
    expect((res as any).stat).not.toBeNull();
    expect((res as any).stat.isDirectory).toBe(false);
    expect((res as any).stat.size).toBe(7);
  });

  it('file_volume_stat returns null for non-existent file', async () => {
    const handlers = createHandlers();
    const res = await handlers.handle({
      type: 'file_volume_stat',
      installationId: 'inst_vol_6',
      workspaceId: 'work_test_001',
      path: 'nonexistent.txt',
    } as FileVolumeStatRequest);
    expect(res.success).toBe(true);
    expect((res as any).stat).toBeNull();
  });

  it('file_volume_delete removes a file', async () => {
    const handlers = createHandlers();
    await fs.writeFile(join(TEST_VOLUME_PATH, 'delete-me.txt'), 'temp');
    const res = await handlers.handle({
      type: 'file_volume_delete',
      installationId: 'inst_vol_7',
      workspaceId: 'work_test_001',
      path: 'delete-me.txt',
    } as FileVolumeDeleteRequest);
    expect(res.success).toBe(true);
    try {
      await fs.access(join(TEST_VOLUME_PATH, 'delete-me.txt'));
      expect(true).toBe(false); // Should not reach here
    } catch {
      // Expected — file should be deleted
    }
  });

  it('rejects path traversal in volume operations', async () => {
    const handlers = createHandlers();
    const res = await handlers.handle({
      type: 'file_volume_read_file',
      installationId: 'inst_vol_8',
      workspaceId: 'work_test_001',
      path: '../../../etc/passwd',
    } as FileVolumeReadFileRequest);
    expect(res.success).toBe(false);
    expect((res as any).error).toContain('path traversal');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle (install/uninstall)
// ---------------------------------------------------------------------------

describe('CallbackHandlers — Lifecycle', () => {
  it('lifecycle_install records the installation', async () => {
    const handlers = createHandlers();
    const res = await handlers.handle({
      type: 'lifecycle_install',
      installationId: 'inst_life_1',
      workspaceId: 'work_test_001',
      userId: 'user_001',
    } as LifecycleInstallRequest);
    expect(res.success).toBe(true);

    // Verify it was recorded in MongoDB
    const doc = await db.collection('agent_app_installations').findOne({ installationId: 'inst_life_1' });
    expect(doc).not.toBeNull();
    expect(doc?.status).toBe('installed');
  });

  it('lifecycle_uninstall marks as uninstalled and cleans up', async () => {
    const handlers = createHandlers();
    // Install first
    await handlers.handle({
      type: 'lifecycle_install',
      installationId: 'inst_life_2',
      workspaceId: 'work_test_001',
    } as LifecycleInstallRequest);

    // Put an object in storage
    await handlers.handle({
      type: 'file_object_put',
      installationId: 'inst_life_2',
      key: 'temp.txt',
      data: Buffer.from('temp').toString('base64'),
    } as FileObjectPutRequest);

    // Uninstall
    const res = await handlers.handle({
      type: 'lifecycle_uninstall',
      installationId: 'inst_life_2',
      workspaceId: 'work_test_001',
    } as LifecycleUninstallRequest);
    expect(res.success).toBe(true);

    // Verify installation is marked as uninstalled
    const doc = await db.collection('agent_app_installations').findOne({ installationId: 'inst_life_2' });
    expect(doc?.status).toBe('uninstalled');

    // Verify object storage was cleaned up
    const getRes = await handlers.handle({
      type: 'file_object_get',
      installationId: 'inst_life_2',
      key: 'temp.txt',
    } as FileObjectGetRequest);
    expect((getRes as any).data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('CallbackHandlers — Error handling', () => {
  it('returns error for unknown callback type', async () => {
    const handlers = createHandlers();
    const res = await handlers.handle({ type: 'unknown_type', installationId: 'i' } as any);
    expect(res.success).toBe(false);
    expect((res as any).error).toContain('Unknown callback type');
  });

  it('catches and returns errors from handlers', async () => {
    const handlers = createHandlers();
    // Force an error by using an invalid workspace
    const res = await handlers.handle({
      type: 'file_volume_read_file',
      installationId: 'inst_err',
      workspaceId: 'work_nonexistent',
      path: 'test.txt',
    } as FileVolumeReadFileRequest);
    expect(res.success).toBe(false);
    expect((res as any).error).toBeDefined();
  });
});
