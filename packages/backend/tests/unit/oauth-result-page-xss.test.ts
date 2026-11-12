import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { HttpAuthHandler } from '../../src/handlers/http-auth-handler';
import { HttpMcaAuthHandler } from '../../src/handlers/http-mca-auth-handler';

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  ended = false;

  writeHead(code: number, headers?: Record<string, string>): this {
    this.statusCode = code;
    if (headers) this.headers = { ...this.headers, ...headers };
    return this;
  }

  end(data?: string): this {
    if (data) this.body = data;
    this.ended = true;
    return this;
  }
}

const PAYLOAD = "</script><script>window.__pwned=1;alert('xss')</script>";

function makeMcaHandler(appUrl: string | undefined): HttpMcaAuthHandler {
  const secretsManager: any = { system: () => (appUrl ? { appUrl } : {}) };
  return new HttpMcaAuthHandler(
    {} as any,
    {} as any,
    {} as any,
    secretsManager,
    {} as any,
    {} as any,
  );
}

function scriptTags(html: string): string[] {
  return html.match(/<script\b[^>]*>/gi) ?? [];
}

let savedAppUrl: string | undefined;
beforeEach(() => {
  savedAppUrl = process.env.APP_URL;
  delete process.env.APP_URL;
});
afterEach(() => {
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
});

describe('OAuth result pages never run request data (019)', () => {
  it('app connect callback: a provider error cannot close the script', async () => {
    const handler = makeMcaHandler('https://app.test');
    const res = new FakeRes();
    const url = `/auth/mca/callback?error=${encodeURIComponent(PAYLOAD)}&state=x`;

    await handler.handleRoute({ method: 'GET', url, headers: { host: 'be.test' } } as any, res as any, url);

    expect(res.ended).toBe(true);
    expect(res.body).not.toContain('</script><script>window.__pwned');
    expect(res.body).not.toContain("alert('xss')</script>");
    expect(scriptTags(res.body).filter((t) => !/type="application\/json"/.test(t))).toHaveLength(1);
  });

  it('app connect callback: the page carries a CSP whose nonce matches its only script', async () => {
    const handler = makeMcaHandler('https://app.test');
    const res = new FakeRes();
    const url = `/auth/mca/callback?error=access_denied&state=x`;

    await handler.handleRoute({ method: 'GET', url, headers: { host: 'be.test' } } as any, res as any, url);

    const csp = res.headers['Content-Security-Policy'] ?? '';
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.body).toContain(`<script nonce="${nonce}">`);
  });

  it('sign-in callback: a provider error cannot close the script', async () => {
    process.env.APP_URL = 'https://app.test';
    const handler = new HttpAuthHandler({} as any, { system: () => ({}) } as any);
    const res = new FakeRes();
    const url = `/auth/google/callback?error=${encodeURIComponent(PAYLOAD)}&state=x`;

    await handler.handleRoute({ method: 'GET', url, headers: { host: 'be.test' } } as any, res as any, url);

    expect(res.ended).toBe(true);
    expect(res.body).not.toContain('</script><script>window.__pwned');
    expect(scriptTags(res.body).filter((t) => !/type="application\/json"/.test(t))).toHaveLength(1);
  });
});
