/**
 * Integration test: MCA resource route for tool permissions
 * (handleAppPermissionsGet / handleAppPermissionsSet).
 *
 * Covers the batch semantics ('all', per-tool map, 'default' unpin,
 * all='default' reset) and the manage-level authz (owner / workspace admin
 * only; plain members and outsiders denied).
 *
 * Uses the ephemeral test MongoDB (MONGODB_URI, default :27019).
 * Skips silently if Mongo is unreachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import {
  handleAppPermissionsGet,
  handleAppPermissionsSet,
} from '../../src/routes/mca-resources-handlers';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27019';
const DB_NAME = `teros_test_apperms_${Date.now()}`;

let client: MongoClient;
let db: Db;
let available = false;

const OWNER = 'user_owner';
const ADMIN = 'user_admin';
const MEMBER = 'user_member';
const OUTSIDER = 'user_outsider';
const WORKSPACE = 'work_perms';
const APP = 'app_perms_test';

// ServerResponse stub that records status + JSON payload.
function makeRes(): any {
  const res: any = {
    status: 0,
    body: undefined,
    writeHead(status: number) {
      res.status = status;
    },
    end(payload: string) {
      res.body = JSON.parse(payload);
    },
  };
  return res;
}

function ctxFor(userId: string): any {
  return { userId, channelId: 'chan_test' };
}

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 });
    db = client.db(DB_NAME);
    available = true;
  } catch {
    console.warn('[app-permissions test] Mongo unreachable — skipping');
    return;
  }

  await db.collection('workspaces').insertOne({
    workspaceId: WORKSPACE,
    ownerId: OWNER,
    status: 'active',
    members: [
      { userId: ADMIN, role: 'admin', addedAt: '', addedBy: OWNER },
      { userId: MEMBER, role: 'write', addedAt: '', addedBy: OWNER },
    ],
  } as any);
  // Membership rows for canAccessApp (workspace-access.ts reads this collection).
  await db.collection('workspace_members').insertMany([
    { workspaceId: WORKSPACE, userId: ADMIN },
    { workspaceId: WORKSPACE, userId: MEMBER },
  ]);
  await db.collection('mca_catalog').insertOne({
    mcaId: 'mca.test.perms',
    tools: ['read-thing', 'write-thing', 'delete-thing', '-health-check'],
  } as any);
});

beforeEach(async () => {
  if (!available) return;
  await db.collection('apps').deleteMany({ appId: APP });
  await db.collection('apps').insertOne({
    appId: APP,
    mcaId: 'mca.test.perms',
    name: 'PermsTest',
    ownerId: WORKSPACE,
    ownerType: 'workspace',
  } as any);
});

afterAll(async () => {
  if (available) {
    await db.dropDatabase();
    await client.close();
  }
});

async function storedPermissions(): Promise<any> {
  const app = await db.collection('apps').findOne({ appId: APP });
  return app?.permissions;
}

describe('handleAppPermissionsSet', () => {
  it('sets per-tool permissions in batch', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppPermissionsSet(res, ctxFor(OWNER), db, APP, {
      tools: { 'write-thing': 'allow', 'delete-thing': 'forbid' },
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const perms = await storedPermissions();
    expect(perms.tools['write-thing']).toBe('allow');
    expect(perms.tools['delete-thing']).toBe('forbid');
    expect(perms.defaultPermission).toBe('ask');
  });

  it("removes a pin with 'default' so the tool inherits again", async () => {
    if (!available) return;
    let res = makeRes();
    await handleAppPermissionsSet(res, ctxFor(OWNER), db, APP, {
      tools: { 'write-thing': 'forbid' },
    });
    expect((await storedPermissions()).tools['write-thing']).toBe('forbid');

    res = makeRes();
    await handleAppPermissionsSet(res, ctxFor(OWNER), db, APP, {
      tools: { 'write-thing': 'default' },
    });
    expect(res.status).toBe(200);
    expect((await storedPermissions()).tools['write-thing']).toBeUndefined();
  });

  it("pins every public tool with 'all' (private tools excluded)", async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppPermissionsSet(res, ctxFor(ADMIN), db, APP, { all: 'forbid' });
    expect(res.status).toBe(200);

    const perms = await storedPermissions();
    expect(perms.defaultPermission).toBe('forbid');
    expect(perms.tools['read-thing']).toBe('forbid');
    expect(perms.tools['write-thing']).toBe('forbid');
    expect(perms.tools['-health-check']).toBeUndefined();
  });

  it("resets everything with all='default'", async () => {
    if (!available) return;
    let res = makeRes();
    await handleAppPermissionsSet(res, ctxFor(OWNER), db, APP, { all: 'forbid' });

    res = makeRes();
    await handleAppPermissionsSet(res, ctxFor(OWNER), db, APP, { all: 'default' });
    expect(res.status).toBe(200);

    const perms = await storedPermissions();
    expect(perms.tools).toEqual({});
    expect(perms.defaultPermission).toBe('ask');
  });

  it("applies per-tool changes on top of 'all'", async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppPermissionsSet(res, ctxFor(OWNER), db, APP, {
      all: 'forbid',
      tools: { 'read-thing': 'allow' },
    });
    expect(res.status).toBe(200);

    const perms = await storedPermissions();
    expect(perms.tools['read-thing']).toBe('allow');
    expect(perms.tools['write-thing']).toBe('forbid');
  });

  it('rejects unknown tools with 404', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppPermissionsSet(res, ctxFor(OWNER), db, APP, {
      tools: { 'no-such-tool': 'allow' },
    });
    expect(res.status).toBe(404);
    expect(await storedPermissions()).toBeUndefined();
  });

  it('rejects invalid permission values with 400', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppPermissionsSet(res, ctxFor(OWNER), db, APP, {
      tools: { 'read-thing': 'yes-please' as any },
    });
    expect(res.status).toBe(400);
  });

  it('rejects an empty request with 400', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppPermissionsSet(res, ctxFor(OWNER), db, APP, {});
    expect(res.status).toBe(400);
  });

  it('denies plain members and outsiders (manage-level check)', async () => {
    if (!available) return;
    for (const userId of [MEMBER, OUTSIDER]) {
      const res = makeRes();
      await handleAppPermissionsSet(res, ctxFor(userId), db, APP, {
        tools: { 'read-thing': 'allow' },
      });
      expect(res.status).toBe(403);
    }
    expect(await storedPermissions()).toBeUndefined();
  });
});

describe('handleAppPermissionsGet', () => {
  it('returns the permissions view for any workspace member', async () => {
    if (!available) return;
    let res = makeRes();
    await handleAppPermissionsSet(res, ctxFor(OWNER), db, APP, {
      tools: { 'delete-thing': 'forbid' },
    });

    res = makeRes();
    await handleAppPermissionsGet(res, ctxFor(MEMBER), db, APP);
    expect(res.status).toBe(200);
    expect(res.body.appId).toBe(APP);
    const byName = Object.fromEntries(res.body.tools.map((t: any) => [t.name, t.permission]));
    expect(byName['delete-thing']).toBe('forbid');
    expect(byName['-health-check']).toBeUndefined();
    expect(res.body.summary.forbid).toBe(1);
  });

  it('denies outsiders', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppPermissionsGet(res, ctxFor(OUTSIDER), db, APP);
    expect(res.status).toBe(403);
  });
});
