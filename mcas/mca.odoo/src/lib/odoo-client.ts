import type { ToolContext } from '@teros/mca-sdk';
import { safeFetch } from '@teros/mca-sdk';

// =============================================================================
// SSRF GUARD
// =============================================================================

// Ports the Odoo BASE_URL may target. 80/443 cover Odoo Online + reverse-proxied
// self-hosts; 8069 is Odoo's default direct HTTP port for un-proxied self-hosts.
// The private/internal-address block in `safeFetch` is independent of this list.
const ALLOWED_PORTS = [80, 443, 8069];

// Test seam: `safeFetch` resolves DNS to catch hostnames that point at internal
// IPs (rebinding). Injecting a fake resolver lets unit tests exercise the guard
// without touching the network. Left undefined in production → real DNS.
type ResolveHost = (host: string) => Promise<Array<{ address: string }>>;
let testResolveHost: ResolveHost | undefined;
export function __setOdooResolveHostForTests(fn: ResolveHost | undefined): void {
  testResolveHost = fn;
}

// =============================================================================
// TYPES
// =============================================================================

export interface OdooSecrets {
  BASE_URL?: string;
  DATABASE?: string;
  API_KEY?: string;
}

export type OdooDomain = Array<string | number | boolean | null | undefined | OdooDomain>;

export interface OdooRpcOptions {
  model?: string;
  service?: 'object' | 'common' | 'db';
  method: string;
  args?: unknown[];
  kwargs?: Record<string, unknown>;
}

export interface OdooSearchOptions {
  domain?: OdooDomain;
  fields?: string[];
  offset?: number;
  limit?: number;
  order?: string;
}

export interface OdooRecord {
  id: number;
  [key: string]: unknown;
}

// =============================================================================
// SECRETS
// =============================================================================

export async function getOdooSecrets(context: ToolContext): Promise<Required<OdooSecrets>> {
  const userSecrets = (await context.getUserSecrets()) as OdooSecrets;

  const baseUrl = (userSecrets.BASE_URL || '').trim();
  const database = (userSecrets.DATABASE || '').trim();
  const apiKey = (userSecrets.API_KEY || '').trim();

  if (!baseUrl) {
    throw new Error(
      'Odoo BASE_URL is not configured. Please set your Odoo instance URL (e.g. https://mycompany.odoo.com).',
    );
  }
  if (!database) {
    throw new Error('Odoo DATABASE is not configured. Please set your Odoo database name.');
  }
  if (!apiKey) {
    throw new Error('Odoo API_KEY is not configured. Please set an API key from your Odoo user profile.');
  }

  return {
    BASE_URL: baseUrl.replace(/\/$/, ''),
    DATABASE: database,
    API_KEY: apiKey,
  };
}

// =============================================================================
// JSON-RPC REQUEST
// =============================================================================

/**
 * Execute a JSON-RPC call against Odoo's /jsonrpc endpoint.
 */
export async function odooJsonRpc<T = unknown>(
  context: ToolContext,
  options: OdooRpcOptions,
): Promise<T> {
  const { BASE_URL, DATABASE, API_KEY } = await getOdooSecrets(context);
  const service = options.service ?? 'object';
  const model = options.model;
  const method = options.method;
  const args = options.args ?? [];
  const kwargs = options.kwargs ?? {};

  const url = `${BASE_URL}/jsonrpc`;

  const rpcArgs =
    service === 'object'
      ? [DATABASE, 1, API_KEY, model, method, args]
      : service === 'common'
        ? [DATABASE, '', API_KEY, {}]
        : args;

  const body = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service,
      method: service === 'object' ? 'execute_kw' : method,
      args: rpcArgs,
      kwargs,
    },
    id: Math.floor(Math.random() * 1_000_000_000),
  };

  // SSRF guard: BASE_URL is a user-supplied secret. Without safeFetch, a value
  // like http://169.254.169.254/ (cloud metadata) or an internal host would make
  // the Teros server POST there and return the response to the caller. safeFetch
  // resolves the host and rejects loopback / private / link-local addresses, and
  // re-validates every redirect hop.
  const response = await safeFetch(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    },
    { allowedPorts: ALLOWED_PORTS, resolveHost: testResolveHost },
  );

  const text = await response.text().catch(() => 'Unknown error');
  let data: {
    error?: { message?: string; data?: { message?: string }; code?: number };
    result?: T;
  };

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Odoo returned non-JSON response (${response.status}): ${text}`);
  }

  if (data.error) {
    const odooMessage = data.error.data?.message || data.error.message || 'Unknown Odoo error';
    throw new Error(`Odoo error (${data.error.code ?? 'N/A'}): ${odooMessage}`);
  }

  return data.result as T;
}

// =============================================================================
// AUTHENTICATION
// =============================================================================

/**
 * Authenticate against Odoo and return the user ID.
 */
export async function authenticate(context: ToolContext): Promise<number> {
  return odooJsonRpc<number>(context, {
    service: 'common',
    method: 'authenticate',
  });
}

// =============================================================================
// GENERIC CRUD HELPERS
// =============================================================================

export async function odooSearchRead(
  context: ToolContext,
  model: string,
  options: OdooSearchOptions = {},
): Promise<OdooRecord[]> {
  const kwargs: Record<string, unknown> = {};
  if (options.fields && options.fields.length > 0) kwargs.fields = options.fields;
  if (options.offset !== undefined) kwargs.offset = options.offset;
  if (options.limit !== undefined) kwargs.limit = options.limit;
  if (options.order) kwargs.order = options.order;

  return odooJsonRpc<OdooRecord[]>(context, {
    model,
    method: 'search_read',
    args: [options.domain ?? []],
    kwargs,
  });
}

export async function odooRead(
  context: ToolContext,
  model: string,
  id: number,
  fields?: string[],
): Promise<OdooRecord | null> {
  const result = await odooJsonRpc<OdooRecord[]>(context, {
    model,
    method: 'read',
    args: [[id]],
    kwargs: fields && fields.length > 0 ? { fields } : {},
  });
  return result?.[0] ?? null;
}

export async function odooCreate(
  context: ToolContext,
  model: string,
  values: Record<string, unknown>,
): Promise<number> {
  return odooJsonRpc<number>(context, {
    model,
    method: 'create',
    args: [values],
  });
}

export async function odooWrite(
  context: ToolContext,
  model: string,
  id: number,
  values: Record<string, unknown>,
): Promise<boolean> {
  return odooJsonRpc<boolean>(context, {
    model,
    method: 'write',
    args: [[id], values],
  });
}

export async function odooUnlink(
  context: ToolContext,
  model: string,
  id: number,
): Promise<boolean> {
  return odooJsonRpc<boolean>(context, {
    model,
    method: 'unlink',
    args: [[id]],
  });
}

export async function odooSearchCount(
  context: ToolContext,
  model: string,
  domain: OdooDomain = [],
): Promise<number> {
  return odooJsonRpc<number>(context, {
    model,
    method: 'search_count',
    args: [domain],
  });
}

export async function odooCallMethod(
  context: ToolContext,
  model: string,
  method: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {},
): Promise<unknown> {
  return odooJsonRpc<unknown>(context, {
    model,
    method,
    args,
    kwargs,
  });
}

// =============================================================================
// FILTER PARSER
// =============================================================================

/**
 * Parse a simple filter string into an Odoo domain.
 * Supports: key=value, key!=value, key>value, key<value, key>=value, key<=value.
 * Multiple filters are ANDed.
 */
export function parseFilters(filters?: string): OdooDomain {
  if (!filters || filters.trim().length === 0) return [];

  const domain: OdooDomain = [];
  const pairs = filters
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  for (const pair of pairs) {
    const match = pair.match(/^([^!=<>]+)(!=|>=|<=|>|<|=)(.*)$/);
    if (!match) continue;

    const [, key, operator, rawValue] = match;
    const field = key.trim();
    const value = parseValue(rawValue.trim());

    domain.push([field, operator, value]);
  }

  return domain;
}

function parseValue(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === 'None') return false;

  const num = Number(value);
  if (!Number.isNaN(num) && value !== '') return num;

  return value;
}
