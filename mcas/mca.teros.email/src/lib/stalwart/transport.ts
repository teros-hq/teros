/**
 * Transport layer — direct access to Stalwart over JMAP (ported from the
 * verified stalwart-tools seed, hardened for the MCA context):
 *
 * baseUrl + admin token (Authorization: Bearer) for admin calls; each mail
 * call authenticates with the mailbox's own basic credentials (user/pass).
 *
 * Auth is per-request, not baked into the transport.
 *
 * Zero dependencies — global fetch (Node 18+).
 */
import { toolError } from '../errors.js';
import type { JmapMethodCall, JmapResult } from './types.js';

const b64 = (s: string): string => Buffer.from(s, 'ascii').toString('base64');

export interface TransportConfig {
  /** Stalwart base URL, e.g. https://relay.teros.ai */
  baseUrl?: string;
  /** Admin API token (Authorization: Bearer). */
  token?: string;
  /** Fetch timeout in ms (default 30s). */
  timeoutMs?: number;
}

/** How a single request authenticates upstream. */
export type AuthMode = { mode: 'token' } | { mode: 'basic'; user: string; pass: string };

/**
 * Hardening for bug #2 (spec §8): Stalwart answers HTTP 200 even when a JMAP
 * method call failed — the failure arrives as an `error` entry inside
 * `methodResponses` (e.g. `serverFail`, `invalidArguments`, `forbidden`).
 * This transport NEVER returns such a response as if it were success: it
 * throws with the server's literal description.
 */
export function assertNoJmapErrors(res: JmapResult): JmapResult {
  const entries = Array.isArray(res?.methodResponses) ? res.methodResponses : null;
  if (!entries) {
    throw toolError(
      'JMAP_ERROR',
      'JMAP response has no methodResponses array',
      'the upstream response is malformed — check STALWART_BASE_URL reachability',
    );
  }
  const firstError = entries.find((r) => r?.[0] === 'error');
  if (firstError) {
    const args = (firstError[1] ?? {}) as { type?: string; description?: string };
    throw toolError(
      'JMAP_ERROR',
      `JMAP ${args.type ?? 'error'}${args.description ? `: ${args.description}` : ''}`,
    );
  }
  return res;
}

export class Transport {
  private readonly cfg: TransportConfig;

  constructor(cfg: TransportConfig) {
    if (!cfg.baseUrl) {
      throw toolError('NOT_CONFIGURED', 'Transport needs baseUrl (direct Stalwart, e.g. https://relay.teros.ai)');
    }
    this.cfg = cfg;
  }

  private authHeaders(auth: AuthMode): Record<string, string> {
    if (auth.mode === 'token') {
      if (!this.cfg.token) {
        throw toolError('NOT_CONFIGURED', 'Direct transport needs STALWART_ADMIN_TOKEN for admin calls');
      }
      return { Authorization: `Bearer ${this.cfg.token}` };
    }
    return { Authorization: `Basic ${b64(`${auth.user}:${auth.pass}`)}` };
  }

  /**
   * Send a JMAP request (POST /jmap/) with explicit auth and hardened error
   * handling: HTTP errors and JMAP error entries inside HTTP 200 are both
   * thrown (never returned as empty results).
   */
  async jmap(using: string[], methodCalls: JmapMethodCall[], auth: AuthMode): Promise<JmapResult> {
    const url = `${this.cfg.baseUrl!.replace(/\/$/, '')}/jmap/`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...this.authHeaders(auth),
      },
      body: JSON.stringify({ using, methodCalls }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw this.upstream(`JMAP request failed: ${res.status} ${res.statusText}`, text);
    }
    try {
      return (await res.json()) as JmapResult;
    } catch {
      throw toolError('UPSTREAM_ERROR', 'JMAP endpoint returned a non-JSON body', `status ${res.status} from ${url}`);
    }
  }

  /** GET a Stalwart path (e.g. /.well-known/jmap). */
  async get(path: string, auth: AuthMode): Promise<unknown> {
    const url = `${this.cfg.baseUrl!.replace(/\/$/, '')}${path}`;
    const res = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...this.authHeaders(auth) },
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw toolError('AUTH_INVALID', `Authentication failed for ${path} (HTTP ${res.status})`, 'check MAIL_ACCOUNT / MAIL_PASSWORD');
      }
      const text = await res.text().catch(() => '');
      throw this.upstream(`GET ${path} failed: ${res.status}`, text);
    }
    return res.json().catch(() => ({}));
  }

  private upstream(message: string, bodyText: string): Error {
    if (/401|403|unauthor|forbidden|credential/i.test(`${message} ${bodyText}`)) {
      return toolError('AUTH_INVALID', message, bodyText.slice(0, 300));
    }
    return toolError('UPSTREAM_ERROR', message, bodyText.slice(0, 300));
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 30_000);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))) {
        throw toolError('TIMEOUT', `Request timed out after ${this.cfg.timeoutMs ?? 30_000}ms`, url);
      }
      throw toolError('NETWORK_ERROR', `Network request failed: ${err instanceof Error ? err.message : String(err)}`, url);
    }
  }
}
