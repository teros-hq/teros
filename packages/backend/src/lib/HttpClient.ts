/**
 * HttpClient — Centralised HTTP client for the Teros backend
 *
 * Features:
 *  - Configurable timeouts (per-client and per-request)
 *  - Automatic retries with exponential backoff for transient failures
 *  - Request / response interceptors
 *  - Structured request logging (stdout JSON lines, opt-in per instance)
 *  - Caller AbortSignal propagated end-to-end (Phase 2.0 — TER-348)
 *
 * Usage:
 *   const client = new HttpClient({ baseUrl: 'https://api.example.com', timeout: 10_000 })
 *   const data = await client.get<MyType>('/endpoint')
 *
 * Singleton helper:
 *   import { getHttpClient } from './HttpClient'
 *   const data = await getHttpClient().get<MyType>('https://full-url')
 */

import { linkAbort } from '@teros/core/util'

// ============================================================================
// TYPES
// ============================================================================

export interface HttpClientConfig {
  /** Base URL prepended to every relative path (optional) */
  baseUrl?: string
  /** Default request timeout in ms (default: 30_000) */
  timeout?: number
  /** Number of retry attempts for retryable errors (default: 0 = no retries) */
  maxRetries?: number
  /** Base delay in ms for exponential backoff (default: 300) */
  retryBaseDelayMs?: number
  /** Maximum delay cap in ms for backoff (default: 10_000) */
  retryMaxDelayMs?: number
  /** HTTP status codes considered retryable (default: [429, 502, 503, 504]) */
  retryStatusCodes?: number[]
  /** Enable structured JSON logging of every request (default: false) */
  logging?: boolean
  /** Label shown in log lines (default: 'HttpClient') */
  logLabel?: string
  /** Default headers merged into every request */
  defaultHeaders?: Record<string, string>
}

export interface RequestOptions {
  /** Override timeout for this single request */
  timeout?: number
  /** Override retry count for this single request */
  maxRetries?: number
  /** Extra headers merged with defaults */
  headers?: Record<string, string>
  /** AbortSignal from caller (stacked with internal timeout signal) */
  signal?: AbortSignal
}

export type RequestInterceptor = (
  url: string,
  init: RequestInit,
) => { url: string; init: RequestInit } | Promise<{ url: string; init: RequestInit }>

export type ResponseInterceptor = (
  response: Response,
  url: string,
) => Response | Promise<Response>

export interface HttpRequestLog {
  ts: string
  label: string
  method: string
  url: string
  status: number | null
  durationMs: number
  attempt: number
  error?: string
}

// ============================================================================
// ERROR
// ============================================================================

export class HttpClientError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly body?: string,
  ) {
    super(message)
    this.name = 'HttpClientError'
  }

  get isRetryable(): boolean {
    return [429, 502, 503, 504].includes(this.statusCode)
  }
}

// ============================================================================
// ABORT SIGNAL HELPERS
// ============================================================================

// `linkAbort` lives in `@teros/core/util` (Phase 2.1). Re-exported here for
// backwards compatibility with code that imports it from this module's path.
export { linkAbort }

// ============================================================================
// CLIENT
// ============================================================================

export class HttpClient {
  private cfg: Required<HttpClientConfig>
  private requestInterceptors: RequestInterceptor[] = []
  private responseInterceptors: ResponseInterceptor[] = []

  constructor(config: HttpClientConfig = {}) {
    this.cfg = {
      baseUrl: config.baseUrl?.replace(/\/$/, '') ?? '',
      timeout: config.timeout ?? 30_000,
      maxRetries: config.maxRetries ?? 0,
      retryBaseDelayMs: config.retryBaseDelayMs ?? 300,
      retryMaxDelayMs: config.retryMaxDelayMs ?? 10_000,
      retryStatusCodes: config.retryStatusCodes ?? [429, 502, 503, 504],
      logging: config.logging ?? false,
      logLabel: config.logLabel ?? 'HttpClient',
      defaultHeaders: config.defaultHeaders ?? {},
    }
  }

  // --------------------------------------------------------------------------
  // Interceptors
  // --------------------------------------------------------------------------

  /** Add a request interceptor. Interceptors run in registration order. */
  addRequestInterceptor(fn: RequestInterceptor): this {
    this.requestInterceptors.push(fn)
    return this
  }

  /** Add a response interceptor. Interceptors run in registration order. */
  addResponseInterceptor(fn: ResponseInterceptor): this {
    this.responseInterceptors.push(fn)
    return this
  }

  // --------------------------------------------------------------------------
  // Public HTTP verbs
  // --------------------------------------------------------------------------

  async get<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options)
  }

  async post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, options)
  }

  async put<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body, options)
  }

  async patch<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, body, options)
  }

  async delete<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options)
  }

  /**
   * Low-level fetch wrapper that accepts a URLSearchParams body (for form-encoded requests).
   * Returns the raw Response — callers parse it themselves.
   */
  async fetchRaw(
    method: string,
    path: string,
    body?: URLSearchParams | string | FormData,
    options?: RequestOptions & { headers?: Record<string, string> },
  ): Promise<Response> {
    const url = this.buildUrl(path)
    const timeout = options?.timeout ?? this.cfg.timeout
    const maxRetries = options?.maxRetries ?? this.cfg.maxRetries

    const baseHeaders: Record<string, string> = {
      ...this.cfg.defaultHeaders,
      ...(options?.headers ?? {}),
    }

    const init: RequestInit = {
      method,
      headers: baseHeaders,
      body: body ?? undefined,
    }

    return this.executeWithRetry(url, init, timeout, maxRetries, options?.signal)
  }

  // --------------------------------------------------------------------------
  // Core
  // --------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const url = this.buildUrl(path)
    const timeout = options?.timeout ?? this.cfg.timeout
    const maxRetries = options?.maxRetries ?? this.cfg.maxRetries

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...this.cfg.defaultHeaders,
      ...(options?.headers ?? {}),
    }

    const init: RequestInit = {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }

    const response = await this.executeWithRetry(url, init, timeout, maxRetries, options?.signal)
    return (await response.json()) as T
  }

  private async executeWithRetry(
    url: string,
    init: RequestInit,
    timeout: number,
    maxRetries: number,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown
    const totalAttempts = maxRetries + 1

    // Short-circuit if the caller already aborted before any attempt.
    if (callerSignal?.aborted) {
      throw new HttpClientError(
        499,
        'ABORTED',
        `Request aborted by caller before sending: ${url}`,
      )
    }

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const startMs = Date.now()
      let status: number | null = null
      let errorMsg: string | undefined

      try {
        // Run request interceptors
        let intercepted = { url, init }
        for (const fn of this.requestInterceptors) {
          intercepted = await fn(intercepted.url, intercepted.init)
        }

        // Timeout + caller-abort via AbortController.
        // The controller fires when either the timeout elapses OR the caller
        // aborts. We distinguish the two cases in the catch via callerSignal.aborted.
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeout)
        linkAbort(controller, callerSignal)

        let response: Response
        try {
          response = await fetch(intercepted.url, {
            ...intercepted.init,
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timeoutId)
        }

        status = response.status

        // Run response interceptors
        for (const fn of this.responseInterceptors) {
          response = await fn(response, intercepted.url)
        }

        // Log
        if (this.cfg.logging) {
          this.log({ url, init, status, durationMs: Date.now() - startMs, attempt })
        }

        if (!response.ok) {
          const body = await response.text()
          const err = new HttpClientError(
            response.status,
            `HTTP_${response.status}`,
            `HTTP ${response.status} ${response.statusText}: ${body.slice(0, 200)}`,
            body,
          )

          // Retry on retryable status codes
          if (
            attempt < totalAttempts &&
            this.cfg.retryStatusCodes.includes(response.status)
          ) {
            lastError = err
            await this.backoff(attempt)
            continue
          }

          throw err
        }

        return response
      } catch (err: unknown) {
        const durationMs = Date.now() - startMs

        if (err instanceof HttpClientError) {
          throw err
        }

        // Caller-abort takes precedence over any other error classification.
        // Some runtimes (Bun, browser) surface aborts as DOMException with
        // varying `name` values, so we trust `callerSignal.aborted` directly
        // rather than relying on `err.name === 'AbortError'`.
        if (callerSignal?.aborted) {
          throw new HttpClientError(
            499,
            'ABORTED',
            `Request aborted by caller: ${url}`,
          )
        }

        if (err instanceof Error) {
          errorMsg = err.message

          if (this.cfg.logging) {
            this.log({ url, init, status, durationMs, attempt, error: errorMsg })
          }

          if (err.name === 'AbortError') {
            // Timeout-abort (caller-abort already handled above): retry per
            // maxRetries policy, throw 504 if exhausted.
            const timeoutErr = new HttpClientError(
              504,
              'TIMEOUT',
              `Request timeout after ${timeout}ms: ${url}`,
            )
            if (attempt < totalAttempts) {
              lastError = timeoutErr
              await this.backoff(attempt)
              continue
            }
            throw timeoutErr
          }

          // Network / connection errors are retryable
          if (attempt < totalAttempts) {
            lastError = new HttpClientError(503, 'CONNECTION_FAILED', err.message)
            await this.backoff(attempt)
            continue
          }

          throw new HttpClientError(503, 'CONNECTION_FAILED', err.message)
        }

        throw new HttpClientError(500, 'UNKNOWN_ERROR', String(err))
      }
    }

    throw lastError ?? new HttpClientError(500, 'UNKNOWN_ERROR', 'Request failed')
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private buildUrl(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path
    }
    return `${this.cfg.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`
  }

  private async backoff(attempt: number): Promise<void> {
    const jitter = Math.random() * 100
    const delay = Math.min(
      this.cfg.retryBaseDelayMs * Math.pow(2, attempt - 1) + jitter,
      this.cfg.retryMaxDelayMs,
    )
    await new Promise((resolve) => setTimeout(resolve, delay))
  }

  private log(entry: {
    url: string
    init: RequestInit
    status: number | null
    durationMs: number
    attempt: number
    error?: string
  }): void {
    const line: HttpRequestLog = {
      ts: new Date().toISOString(),
      label: this.cfg.logLabel,
      method: (entry.init.method ?? 'GET').toUpperCase(),
      url: entry.url,
      status: entry.status,
      durationMs: entry.durationMs,
      attempt: entry.attempt,
      error: entry.error,
    }
    console.log(JSON.stringify(line))
  }
}

// ============================================================================
// SINGLETON — general-purpose client (no base URL, no retries by default)
// ============================================================================

let _defaultInstance: HttpClient | null = null

/**
 * Returns a shared HttpClient instance suitable for one-off requests.
 * For service-specific clients (Ollama, OAuth endpoints) create dedicated instances.
 */
export function getHttpClient(): HttpClient {
  if (!_defaultInstance) {
    _defaultInstance = new HttpClient({ timeout: 30_000, maxRetries: 2 })
  }
  return _defaultInstance
}
