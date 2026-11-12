/**
 * HttpAuthHandler — /auth/session cookie endpoints (Req 6.6.1).
 *
 * On web the session token is in-memory only; the httpOnly `teros_session`
 * cookie on the backend origin is what makes the session survive reloads.
 * Tests that:
 * - GET  validates the cookie and returns the session STATE (userId, user,
 *   expiresAt) — and NEVER the token (F2) — re-issuing the cookie (sliding
 *   expiration); invalid/missing cookie → 401 (+ clear).
 * - POST installs the cookie for a valid Bearer token; 401 otherwise.
 * - DELETE revokes the session (best-effort) and clears the cookie.
 * - Other methods → 405.
 */

import { describe, expect, it } from 'bun:test';
import { HttpAuthHandler } from '../../src/handlers/http-auth-handler';

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

class FakeRes {
  statusCode = 0;
  headers: Record<string, string | string[]> = {};
  body = '';
  ended = false;

  setHeader(name: string, value: string | string[]): void {
    this.headers[name] = value;
  }

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

  get setCookie(): string | undefined {
    const value = this.headers['Set-Cookie'];
    return Array.isArray(value) ? value[0] : value;
  }
}

function makeReq(opts: {
  method: string;
  cookie?: string;
  authorization?: string;
}): any {
  return {
    method: opts.method,
    url: '/auth/session',
    headers: {
      host: 'localhost:10001',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
    },
    socket: { encrypted: false, remoteAddress: '127.0.0.1' },
  };
}

const VALID_TOKEN = 'valid-token';
const CLIENT_USER = {
  userId: 'user_1',
  profile: { displayName: 'Test', email: 'test@x.com' },
  role: 'user',
};

function makeHandler(overrides?: { logout?: (token: string) => Promise<boolean> }): {
  handler: HttpAuthHandler;
  logoutCalls: string[];
} {
  const handler = new HttpAuthHandler({} as any);
  const logoutCalls: string[] = [];
  // Replace the internally-constructed AuthHandler with a fake — the real one
  // needs a live AuthService/Mongo connection.
  (handler as any).authHandler = {
    authenticate: async (message: any) => {
      if (message.method === 'token' && message.sessionToken === VALID_TOKEN) {
        return {
          success: true,
          userId: 'user_1',
          sessionToken: VALID_TOKEN,
          user: CLIENT_USER,
          sessionExpiresAt: '2026-12-02T17:00:00.000Z',
        };
      }
      return { success: false, error: 'Invalid session token' };
    },
    logout:
      overrides?.logout ??
      (async (token: string) => {
        logoutCalls.push(token);
        return true;
      }),
  };
  return { handler, logoutCalls };
}

async function call(
  handler: HttpAuthHandler,
  req: any,
): Promise<FakeRes> {
  const res = new FakeRes();
  const handled = await handler.handleRoute(req, res as any, '/auth/session');
  expect(handled).toBe(true);
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/session — restore session from cookie
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /auth/session', () => {
  it('401 without a session cookie', async () => {
    const { handler } = makeHandler();
    const res = await call(handler, makeReq({ method: 'GET' }));
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.success).toBe(false);
  });

  it('401 + cookie clear for an invalid/expired cookie', async () => {
    const { handler } = makeHandler();
    const res = await call(
      handler,
      makeReq({ method: 'GET', cookie: 'teros_session=expired' }),
    );
    expect(res.statusCode).toBe(401);
    expect(res.setCookie).toContain('teros_session=;');
    expect(res.setCookie).toContain('Max-Age=0');
  });

  it('200 with session state (userId, user, expiresAt) for a valid cookie, re-issuing the cookie', async () => {
    const { handler } = makeHandler();
    const res = await call(
      handler,
      makeReq({ method: 'GET', cookie: `teros_session=${VALID_TOKEN}` }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({
      success: true,
      userId: 'user_1',
      user: CLIENT_USER,
      expiresAt: '2026-12-02T17:00:00.000Z',
    });
    // Sliding expiration: the cookie is set again with a fresh Max-Age
    expect(res.setCookie).toContain(`teros_session=${VALID_TOKEN}`);
    expect(res.setCookie).toContain('HttpOnly');
    expect(res.setCookie).toContain('SameSite=Lax');
    expect(res.setCookie).toMatch(/Max-Age=[1-9]\d*/);
    // Session state must never be cached
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  // F2 — the core regression test of this fix: any same-origin script
  // (shared HTML served from /objects, XSS) can fetch this endpoint with the
  // victim's cookie. The 30-day session token must never appear in the body,
  // or the httpOnly cookie's protection is void.
  it('F2: GET /auth/session NEVER returns the session token in the body', async () => {
    const { handler } = makeHandler();
    const res = await call(
      handler,
      makeReq({ method: 'GET', cookie: `teros_session=${VALID_TOKEN}` }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.stringify(res.jsonBody);
    expect(body).not.toContain(VALID_TOKEN);
    expect(res.jsonBody.token).toBeUndefined();
    expect(res.jsonBody.sessionToken).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/session — install cookie from Bearer token
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /auth/session', () => {
  it('401 without a Bearer token', async () => {
    const { handler } = makeHandler();
    const res = await call(handler, makeReq({ method: 'POST' }));
    expect(res.statusCode).toBe(401);
  });

  it('401 for an invalid Bearer token (no cookie installed)', async () => {
    const { handler } = makeHandler();
    const res = await call(
      handler,
      makeReq({ method: 'POST', authorization: 'Bearer bad-token' }),
    );
    expect(res.statusCode).toBe(401);
    expect(res.setCookie).toBeUndefined();
  });

  it('204 + Set-Cookie for a valid Bearer token', async () => {
    const { handler } = makeHandler();
    const res = await call(
      handler,
      makeReq({ method: 'POST', authorization: `Bearer ${VALID_TOKEN}` }),
    );
    expect(res.statusCode).toBe(204);
    expect(res.setCookie).toContain(`teros_session=${VALID_TOKEN}`);
    expect(res.setCookie).toContain('HttpOnly');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /auth/session — logout
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /auth/session', () => {
  it('revokes the cookie session and clears the cookie', async () => {
    const { handler, logoutCalls } = makeHandler();
    const res = await call(
      handler,
      makeReq({ method: 'DELETE', cookie: `teros_session=${VALID_TOKEN}` }),
    );
    expect(res.statusCode).toBe(204);
    expect(logoutCalls).toEqual([VALID_TOKEN]);
    expect(res.setCookie).toContain('teros_session=;');
    expect(res.setCookie).toContain('Max-Age=0');
  });

  it('still clears the cookie when there is no cookie to revoke', async () => {
    const { handler, logoutCalls } = makeHandler();
    const res = await call(handler, makeReq({ method: 'DELETE' }));
    expect(res.statusCode).toBe(204);
    expect(logoutCalls).toEqual([]);
    expect(res.setCookie).toContain('Max-Age=0');
  });

  it('clears the cookie even if server-side revocation throws', async () => {
    const { handler } = makeHandler({
      logout: async () => {
        throw new Error('db down');
      },
    });
    const res = await call(
      handler,
      makeReq({ method: 'DELETE', cookie: `teros_session=${VALID_TOKEN}` }),
    );
    expect(res.statusCode).toBe(204);
    expect(res.setCookie).toContain('Max-Age=0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Method handling
// ─────────────────────────────────────────────────────────────────────────────

describe('other methods', () => {
  it('405 with Allow header', async () => {
    const { handler } = makeHandler();
    const res = await call(handler, makeReq({ method: 'PATCH' }));
    expect(res.statusCode).toBe(405);
    expect(res.headers['Allow']).toBe('GET, POST, DELETE');
  });
});
