import { withRetry, withTimeout } from '@teros/mca-sdk';
import { Context7AuthError, Context7Error, Context7NotFoundError, Context7RateLimitError } from './errors';

const BASE_URL = 'https://context7.com/api';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchOptions {
  apiKey?: string;
  searchParams?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RawResponse {
  status: number;
  text: string;
  contentType: string;
}

async function rawFetch(path: string, options: FetchOptions): Promise<RawResponse> {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(options.searchParams ?? {})) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain',
    'user-agent': 'Teros-MCA-Context7/1.0',
  };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

  const res = await fetch(url, { headers, signal: options.signal });
  const text = await res.text();
  return { status: res.status, text, contentType: res.headers.get('content-type') ?? '' };
}

export async function fetchContext7Raw(path: string, options: FetchOptions = {}): Promise<RawResponse> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const exec = async () => {
    const result = await withTimeout(() => rawFetch(path, options), timeout);
    if (result.status === 401) throw new Context7AuthError();
    if (result.status === 404) throw new Context7NotFoundError();
    if (result.status === 429) throw new Context7RateLimitError();
    if (result.status >= 400) {
      throw new Context7Error(`Context7 HTTP ${result.status}: ${result.text.slice(0, 200)}`, result.status);
    }
    return result;
  };

  return withRetry(exec, {
    retries: 2,
    initialDelayMs: 500,
    backoff: 'exponential',
    shouldRetry: (err) => {
      if (err instanceof Context7AuthError) return false;
      if (err instanceof Context7NotFoundError) return false;
      if (err instanceof Context7RateLimitError) return true;
      return true;
    },
  });
}

export async function fetchContext7Json<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const result = await fetchContext7Raw(path, options);
  try {
    return JSON.parse(result.text) as T;
  } catch {
    throw new Context7Error(`Context7 returned non-JSON body: ${result.text.slice(0, 120)}`);
  }
}
