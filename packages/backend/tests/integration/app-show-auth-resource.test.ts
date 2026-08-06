/**
 * Integration test: MCA resource route for showing an app's auth widget
 * (handleAppShowAuth — the `show-app-auth` core tool).
 *
 * The tool result is rendered by the chat as an inline auth widget, so the
 * handler only authorizes and returns data (no WS broadcast). Covers the
 * auth-status passthrough (and its best-effort degradation when McaOAuth is
 * missing or throws) and authz (workspace members allowed, outsiders denied).
 *
 * Uses the ephemeral test MongoDB (MONGODB_URI, default :27019).
 * Skips silently if Mongo is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import { handleAppCheckAuth, handleAppShowAuth } from '../../src/routes/mca-resources-handlers';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27019';
const DB_NAME = `teros_test_appshowauth_${Date.now()}`;

let client: MongoClient;
let db: Db;
let available = false;

const OWNER = 'user_owner';
const MEMBER = 'user_member';
const OUTSIDER = 'user_outsider';
const WORKSPACE = 'work_showauth';
const APP = 'app_showauth_test';

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

const READY_AUTH = {
  status: 'ready',
  authType: 'oauth2',
  message: 'Connected',
  oauth: { provider: 'google', connected: true, email: 'x@y.z' },
};

function makeOAuth(result: any = READY_AUTH): any {
  return {
    getAuthStatus: async () => result,
  };
}

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 });
    db = client.db(DB_NAME);
    available = true;
  } catch {
    console.warn('[app-show-auth test] Mongo unreachable — skipping');
    return;
  }

  await db.collection('workspaces').insertOne({
    workspaceId: WORKSPACE,
    ownerId: OWNER,
    status: 'active',
    members: [{ userId: MEMBER, role: 'write', addedAt: '', addedBy: OWNER }],
  } as any);
  // Membership rows for canAccessApp (workspace-access.ts reads this collection).
  await db.collection('workspace_members').insertOne({ workspaceId: WORKSPACE, userId: MEMBER });
  await db.collection('mca_catalog').insertOne({
    mcaId: 'mca.test.showauth',
    tools: ['do-thing'],
  } as any);
  await db.collection('apps').insertOne({
    appId: APP,
    mcaId: 'mca.test.showauth',
    name: 'ShowAuthTest',
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

describe('handleAppShowAuth', () => {
  it('returns the app identity and its auth status for the inline widget', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppShowAuth(res, ctxFor(OWNER), db, APP, makeOAuth());

    expect(res.status).toBe(200);
    expect(res.body.displayed).toBe(true);
    expect(res.body.appId).toBe(APP);
    expect(res.body.appName).toBe('ShowAuthTest');
    // The widget derives the target app's icon from its mcaId.
    expect(res.body.mcaId).toBe('mca.test.showauth');
    // Only safe fields are relayed to the agent — no oauth/token details.
    expect(res.body.auth).toEqual({ status: 'ready', authType: 'oauth2', message: 'Connected' });
  });

  it('relays an expired status so the agent can explain the re-auth', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppShowAuth(
      res,
      ctxFor(MEMBER),
      db,
      APP,
      makeOAuth({ status: 'expired', authType: 'oauth2', message: 'Session expired, reconnect account' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.auth.status).toBe('expired');
  });

  it('still shows the widget when McaOAuth is unavailable', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppShowAuth(res, ctxFor(OWNER), db, APP, undefined);

    expect(res.status).toBe(200);
    expect(res.body.displayed).toBe(true);
    expect(res.body.auth).toBeUndefined();
  });

  it('still shows the widget when getAuthStatus throws (best-effort)', async () => {
    if (!available) return;
    const res = makeRes();
    const oauth = {
      getAuthStatus: async () => {
        throw new Error('provider down');
      },
    };
    await handleAppShowAuth(res, ctxFor(OWNER), db, APP, oauth as any);

    expect(res.status).toBe(200);
    expect(res.body.displayed).toBe(true);
    expect(res.body.auth).toBeUndefined();
  });

  it('denies outsiders', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppShowAuth(res, ctxFor(OUTSIDER), db, APP, makeOAuth());

    expect(res.status).toBe(403);
  });

  it('denies an unknown app (canAccessApp gates first)', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppShowAuth(res, ctxFor(OWNER), db, 'app_nope', makeOAuth());

    expect(res.status).toBe(403);
  });
});

describe('handleAppCheckAuth', () => {
  it('returns the auth status for the agent (same safe fields as show)', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppCheckAuth(res, ctxFor(OWNER), db, APP, makeOAuth());

    expect(res.status).toBe(200);
    expect(res.body.appId).toBe(APP);
    expect(res.body.mcaId).toBe('mca.test.showauth');
    expect(res.body.auth).toEqual({ status: 'ready', authType: 'oauth2', message: 'Connected' });
    // Healthy status → no remediation note.
    expect(res.body.note).toBeUndefined();
  });

  it('suggests show-app-auth when the status is broken', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppCheckAuth(
      res,
      ctxFor(MEMBER),
      db,
      APP,
      makeOAuth({ status: 'expired', authType: 'oauth2', message: 'Session expired, reconnect account' }),
    );

    expect(res.status).toBe(200);
    expect(res.body.auth.status).toBe('expired');
    expect(res.body.note).toContain('show-app-auth');
  });

  it('fails loudly when McaOAuth is unavailable (status IS the answer)', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppCheckAuth(res, ctxFor(OWNER), db, APP, undefined);

    expect(res.status).toBe(503);
  });

  it('fails loudly when getAuthStatus throws', async () => {
    if (!available) return;
    const res = makeRes();
    const oauth = {
      getAuthStatus: async () => {
        throw new Error('provider down');
      },
    };
    await handleAppCheckAuth(res, ctxFor(OWNER), db, APP, oauth as any);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('provider down');
  });

  it('denies outsiders', async () => {
    if (!available) return;
    const res = makeRes();
    await handleAppCheckAuth(res, ctxFor(OUTSIDER), db, APP, makeOAuth());

    expect(res.status).toBe(403);
  });
});
