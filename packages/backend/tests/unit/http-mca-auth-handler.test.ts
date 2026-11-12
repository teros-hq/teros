/**
 * HttpMcaAuthHandler — session token migration from URL params to Bearer headers (Req 2.1.1).
 *
 * Tests that:
 * - getUserIdFromRequest accepts Bearer header and cookie, but NOT ?token= query param
 * - handleConnect returns JSON { url } when Accept: application/json
 * - handleConnect returns 302 redirect when no Accept: application/json
 * - Unauthenticated requests are rejected with 401
 */

import { describe, expect, it, mock } from 'bun:test';
import { HttpMcaAuthHandler } from '../../src/handlers/http-mca-auth-handler';

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  ended = false;

  writeHead(code: number, headers?: Record<string, string>): void {
    this.statusCode = code;
    if (headers) this.headers = { ...this.headers, ...headers };
  }

  end(data?: string): void {
    if (data) this.body = data;
    this.ended = true;
  }

  get jsonBody(): any {
    return JSON.parse(this.body);
  }

  get locationHeader(): string | undefined {
    return this.headers['Location'] ?? this.headers['location'];
  }
}

function makeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string;
}): any {
  const headers: Record<string, string | undefined> = { host: 'localhost:10001', ...opts.headers };
  if (opts.cookies) headers.cookie = opts.cookies;
  return {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/auth/mca/app_test/connect',
    headers,
  };
}

function makeHandler(overrides?: {
  validateSession?: (token: string) => Promise<any>;
  getApp?: (appId: string) => Promise<any>;
  getMcaFromCatalog?: (mcaId: string) => Promise<any>;
  generateAuthUrl?: (appId: string, userId: string, mcaId: string, redirectUri: string) => Promise<any>;
  canAccess?: (workspaceId: string, userId: string) => Promise<boolean>;
}): HttpMcaAuthHandler {
  const authService: any = {
    validateSession: overrides?.validateSession ?? (async (token: string) => {
      if (token === 'valid-token') return { success: true, user: { userId: 'user_1' } };
      return { success: false };
    }),
  };

  const mcaService: any = {
    getApp: overrides?.getApp ?? (async (appId: string) => ({
      appId,
      mcaId: 'mca.test',
      ownerId: 'user_1',
      ownerType: 'user',
    })),
    getMcaFromCatalog: overrides?.getMcaFromCatalog ?? (async () => ({
      auth: { type: 'oauth', oauth: {} },
    })),
  };

  const mcaOAuth: any = {
    generateAuthUrl: overrides?.generateAuthUrl ?? (async () => ({
      url: 'https://provider.com/auth?client_id=xxx',
    })),
  };

  const secretsManager: any = {
    system: () => ({ backendUrl: 'https://be.test' }),
  };

  const workspaceService: any = {
    canAccess: overrides?.canAccess ?? (async () => true),
  };

  const githubAppService: any = {};

  return new HttpMcaAuthHandler(
    mcaOAuth,
    mcaService,
    authService,
    secretsManager,
    workspaceService,
    githubAppService,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('HttpMcaAuthHandler — Req 2.1.1: Bearer headers, no URL token', () => {
  describe('handleConnect — JSON mode (Accept: application/json)', () => {
    it('returns { url } JSON when Bearer header is valid', async () => {
      const handler = makeHandler();
      const req = makeReq({
        headers: {
          authorization: 'Bearer valid-token',
          accept: 'application/json',
        },
      });
      const res = new FakeRes();

      await handler.handleRoute(req as any, res as any, req.url);

      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('application/json');
      expect(res.jsonBody.url).toBe('https://provider.com/auth?client_id=xxx');
    });

    it('rejects with 401 when no auth header and no cookie', async () => {
      const handler = makeHandler();
      const req = makeReq({
        headers: { accept: 'application/json' },
      });
      const res = new FakeRes();

      await handler.handleRoute(req as any, res as any, req.url);

      expect(res.statusCode).toBe(401);
    });

    it('rejects with 401 when token is in query param (no longer supported)', async () => {
      const handler = makeHandler();
      const req = makeReq({
        url: '/auth/mca/app_test/connect?token=valid-token',
        headers: { accept: 'application/json' },
      });
      const res = new FakeRes();

      await handler.handleRoute(req as any, res as any, '/auth/mca/app_test/connect?token=valid-token');

      // Should be 401 — query param tokens are no longer accepted
      expect(res.statusCode).toBe(401);
    });

    it('accepts teros_session cookie as fallback', async () => {
      const handler = makeHandler();
      const req = makeReq({
        headers: { accept: 'application/json' },
        cookies: 'teros_session=valid-token',
      });
      const res = new FakeRes();

      await handler.handleRoute(req as any, res as any, req.url);

      expect(res.statusCode).toBe(200);
      expect(res.jsonBody.url).toBe('https://provider.com/auth?client_id=xxx');
    });
  });

  describe('handleConnect — 302 redirect mode (backward compat)', () => {
    it('returns 302 redirect when no Accept: application/json', async () => {
      const handler = makeHandler();
      const req = makeReq({
        headers: { authorization: 'Bearer valid-token' },
      });
      const res = new FakeRes();

      await handler.handleRoute(req as any, res as any, req.url);

      expect(res.statusCode).toBe(302);
      expect(res.locationHeader).toBe('https://provider.com/auth?client_id=xxx');
    });
  });

  describe('handleDisconnect — Bearer header required', () => {
    it('rejects with 401 when token is in query param only', async () => {
      const handler = makeHandler();
      const req = makeReq({
        method: 'POST',
        url: '/auth/mca/app_test/disconnect?token=valid-token',
      });
      const res = new FakeRes();

      await handler.handleRoute(req as any, res as any, '/auth/mca/app_test/disconnect?token=valid-token');

      expect(res.statusCode).toBe(401);
    });

    it('accepts Bearer header', async () => {
      const handler = makeHandler({
        getApp: async () => ({
          appId: 'app_test',
          mcaId: 'mca.test',
          ownerId: 'user_1',
          ownerType: 'user',
        }),
      });
      const disconnectMock = mock(() => Promise.resolve());
      const mcaOAuth: any = {
        generateAuthUrl: async () => ({ url: 'https://provider.com/auth' }),
        disconnect: disconnectMock,
      };
      const secretsManager: any = { system: () => ({ backendUrl: 'https://be.test' }) };
      const workspaceService: any = { canAccess: async () => true };
      const githubAppService: any = {};
      const authService: any = {
        validateSession: async (token: string) => {
          if (token === 'valid-token') return { success: true, user: { userId: 'user_1' } };
          return { success: false };
        },
      };
      const mcaService: any = {
        getApp: async () => ({
          appId: 'app_test',
          mcaId: 'mca.test',
          ownerId: 'user_1',
          ownerType: 'user',
        }),
        getMcaFromCatalog: async () => ({ auth: { type: 'oauth' } }),
      };

      const handler2 = new HttpMcaAuthHandler(
        mcaOAuth, mcaService, authService, secretsManager, workspaceService, githubAppService,
      );

      const req = makeReq({
        method: 'POST',
        url: '/auth/mca/app_test/disconnect',
        headers: { authorization: 'Bearer valid-token' },
      });
      const res = new FakeRes();

      await handler2.handleRoute(req as any, res as any, req.url);

      expect(res.statusCode).toBe(200);
      expect(disconnectMock).toHaveBeenCalled();
    });
  });
});
