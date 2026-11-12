import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createMcaCallbackRoutes } from '../../src/routes/mca-callback-routes';
import { issueMcaCallGrant, resolveMcaCallGrant } from '../../src/services/mca-call-grants';
import { executeToolViaHttp } from '../../src/services/mca-manager.tools';

type Row = Record<string, unknown>;

function fakeDb(apps: Row[], workspaces: Row[]) {
  const store: Record<string, Row[]> = { apps, workspaces };
  return {
    collection(name: string) {
      const rows = store[name] ?? [];
      return {
        findOne: async (q: Row) => rows.find((row) => Object.entries(q).every(([k, v]) => row[k] === v)) ?? null,
      };
    },
  } as any;
}

function fakeContainerManager(tokens: Record<string, string>, mcaIds: Record<string, string>) {
  return {
    verifyCallbackToken: (key: string, token: string) => tokens[key] === token,
    getInfo: (key: string) => (mcaIds[key] ? { mcaId: mcaIds[key] } : undefined),
    getCallbackTokenMcaId: (key: string) => mcaIds[key],
    touch() {},
  } as any;
}

function mockReq(url: string, headers: Record<string, string>, body: unknown): IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as any;
  req.method = 'POST';
  req.url = url;
  req.headers = headers;
  return req as IncomingMessage;
}

function mockRes() {
  const cap: { status?: number; body?: string } = {};
  const res: any = {
    writeHead(status: number) {
      cap.status = status;
      return res;
    },
    end(data?: string) {
      cap.body = data;
    },
  };
  return { res: res as ServerResponse, cap };
}

const OWNER = 'user_owner';
const MEMBER = 'user_member';

function makeHandler() {
  const db = fakeDb(
    [
      { appId: 'app_gh', mcaId: 'mca.github', ownerId: 'work_w', ownerType: 'workspace' },
      { appId: 'app_gmail', mcaId: 'mca.google.gmail', ownerId: 'work_w', ownerType: 'workspace' },
    ],
    [{ workspaceId: 'work_w', ownerId: OWNER }],
  );
  const authManager: any = {
    get: async (userId: string, appId: string) =>
      userId === OWNER ? { USER_ACCESS_TOKEN: `owner-token-${appId}`, USER_LOGIN: 'owner' } : null,
  };
  const mcaService: any = {
    getMcaFromCatalog: async (mcaId: string) =>
      mcaId === 'mca.github'
        ? { auth: { type: 'github-app', userOAuth: true } }
        : { auth: { type: 'oauth2' } },
  };
  const containerManager = fakeContainerManager(
    { app_gh: 'tokGh', app_gmail: 'tokGmail' },
    { app_gh: 'mca.github', app_gmail: 'mca.google.gmail' },
  );
  return createMcaCallbackRoutes({ db, authManager, mcaService, containerManager } as any);
}

async function askUserSecrets(segment: string, appId: string, token: string) {
  const handler = makeHandler();
  const url = `/mca/callback/${segment}/secrets/user`;
  const { res, cap } = mockRes();
  await handler(mockReq(url, { 'x-app-id': appId, authorization: `Bearer ${token}` }, {}), res, url);
  return { status: cap.status, body: cap.body ? JSON.parse(cap.body) : undefined };
}

describe('user secrets resolve for the user who made the tool call (003)', () => {
  test("a member without their own GitHub connection never gets the owner's token", async () => {
    const grant = issueMcaCallGrant({ appId: 'app_gh', userId: MEMBER, channelId: 'ch_member' });
    const { status, body } = await askUserSecrets(grant, 'app_gh', 'tokGh');
    expect(status).toBe(200);
    expect(body.authenticated).toBe(false);
    expect(JSON.stringify(body)).not.toContain('owner-token');
  });

  test('the owner calling through their own conversation gets their own token', async () => {
    const grant = issueMcaCallGrant({ appId: 'app_gh', userId: OWNER, channelId: 'ch_owner' });
    const { body } = await askUserSecrets(grant, 'app_gh', 'tokGh');
    expect(body.authenticated).toBe(true);
    expect(body.secrets.USER_ACCESS_TOKEN).toBe('owner-token-app_gh');
  });

  test('a per-user app asked without a call grant does not fall back to the owner', async () => {
    const { body } = await askUserSecrets('app_gh', 'app_gh', 'tokGh');
    expect(body.authenticated).toBe(false);
    expect(JSON.stringify(body)).not.toContain('owner-token');
  });

  test("a grant issued for another app is refused", async () => {
    const grant = issueMcaCallGrant({ appId: 'app_gmail', userId: OWNER, channelId: 'ch_owner' });
    const { status } = await askUserSecrets(grant, 'app_gh', 'tokGh');
    expect(status).toBe(403);
  });

  test('apps without per-user auth keep the workspace credential', async () => {
    const { body } = await askUserSecrets('app_gmail', 'app_gmail', 'tokGmail');
    expect(body.authenticated).toBe(true);
    expect(body.secrets.USER_ACCESS_TOKEN).toBe('owner-token-app_gmail');
  });
});

describe('executeToolViaHttp hands the MCA a callback URL bound to the calling user (003)', () => {
  test('the callback URL carries a grant for context.userId', async () => {
    let seenCallbackUrl = '';
    const httpClient: any = {
      callTool: async (_name: string, _input: unknown, execution: { callbackUrl: string }) => {
        seenCallbackUrl = execution.callbackUrl;
        return { success: true, result: 'ok' };
      },
    };
    const ctx: any = {
      mcas: new Map(),
      httpClients: new Map(),
      config: { serverPort: 10001 },
      containerManager: { touch: () => {} },
      containerBackendHost: 'localhost',
    };
    const managed: any = { appId: 'app_gh', mcaId: 'mca.github', containerKey: 'app_gh', lastUsed: new Date() };

    await executeToolViaHttp(ctx, managed, 'get-user', {}, httpClient, {
      userId: MEMBER,
      channelId: 'ch_member',
      workspaceId: 'work_w',
    });

    const segment = seenCallbackUrl.split('/mca/callback/')[1];
    expect(resolveMcaCallGrant(segment)).toMatchObject({ appId: 'app_gh', userId: MEMBER, channelId: 'ch_member' });
  });
});
