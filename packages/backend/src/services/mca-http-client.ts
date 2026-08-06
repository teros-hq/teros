/**
 * MCA HTTP Client
 *
 * Client for communicating with MCAs running as HTTP services.
 * Used by McaManager to call containerized MCAs.
 *
 *
 */

import type {
  McaErrorResponse,
  McaExecutionContext,
  McaHealthStatusResponse,
  McaToolCallRequest,
  McaToolResultResponse,
  McaToolsListResponse,
} from '@teros/shared';
import { generateMessageId, MCA_PROTOCOL_VERSION } from '@teros/shared';
import { HttpClient, HttpClientError } from '../lib/HttpClient';

// ============================================================================
// TYPES
// ============================================================================

export interface McaHttpClientConfig {
  /** Base URL of the MCA service (e.g., 'http://mca-bash:3000') */
  baseUrl: string;
  /** Request timeout in ms (default: 120000) */
  timeout?: number;
  /** Retry attempts for transient failures (default: 3) */
  maxRetries?: number;
}

export interface ToolCallOptions {
  /** Override timeout for this call */
  timeout?: number;
  /** When aborted, `callTool` rejects with `McaHttpError(499, 'ABORTED')`. */
  signal?: AbortSignal;
}

// ============================================================================
// HTTP CLIENT
// ============================================================================

export class McaHttpClient {
  private config: Required<McaHttpClientConfig>;
  private http: HttpClient;

  constructor(config: McaHttpClientConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ''), // Remove trailing slash
      timeout: config.timeout ?? 120000,
      maxRetries: config.maxRetries ?? 3,
    };
    this.http = new HttpClient({
      baseUrl: this.config.baseUrl,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
      retryStatusCodes: [503, 504, 429],
      logging: false,
      logLabel: 'McaHttpClient',
    });
  }

  /**
   * Call a tool on the MCA
   */
  async callTool(
    tool: string,
    args: Record<string, unknown>,
    context: McaExecutionContext,
    options?: ToolCallOptions,
  ): Promise<McaToolResultResponse> {
    const requestId = generateMessageId();
    const timeout = options?.timeout ?? this.config.timeout;

    const request: McaToolCallRequest = {
      id: requestId,
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      version: MCA_PROTOCOL_VERSION,
      tool,
      arguments: args,
      context,
    };

    const response = await this.post<McaToolResultResponse>(
      '/tools/call',
      request,
      timeout,
      options?.signal,
    );
    return response;
  }

  /**
   * List available tools
   */
  async listTools(): Promise<McaToolsListResponse> {
    return this.get<McaToolsListResponse>('/tools/list');
  }

  /**
   * Check MCA health
   */
  async healthCheck(): Promise<McaHealthStatusResponse> {
    return this.get<McaHealthStatusResponse>('/health');
  }

  /**
   * Request graceful shutdown
   */
  async shutdown(): Promise<void> {
    await this.post('/shutdown', {});
  }

  /**
   * Check if MCA is reachable
   */
  async isReachable(): Promise<boolean> {
    try {
      const health = await this.healthCheck();
      return health.status === 'ready' || health.status === 'degraded';
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // HTTP HELPERS
  // ==========================================================================

  private async get<T>(path: string, timeout?: number, signal?: AbortSignal): Promise<T> {
    return this.httpRequest<T>('GET', path, undefined, timeout, signal);
  }

  private async post<T>(
    path: string,
    body: unknown,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.httpRequest<T>('POST', path, body, timeout, signal);
  }

  /**
   * Delegates to the centralised HttpClient and maps generic HttpClientErrors
   * to MCA-specific McaHttpErrors so callers keep the same error contract.
   */
  private async httpRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      if (method === 'GET') {
        return await this.http.get<T>(path, { timeout, signal });
      }
      return await this.http.post<T>(path, body, { timeout, signal });
    } catch (error: unknown) {
      if (error instanceof HttpClientError) {
        // Attempt to parse MCA error envelope from the raw body
        let errorData: McaErrorResponse | undefined;
        if (error.body) {
          try {
            errorData = JSON.parse(error.body);
          } catch {
            // Not JSON — ignore
          }
        }
        throw new McaHttpError(
          error.statusCode,
          errorData?.error?.code || error.code,
          errorData?.error?.message || error.message,
          errorData,
        );
      }
      // Caller-abort wins over any low-level fetch error.
      if (signal?.aborted) {
        throw new McaHttpError(499, 'ABORTED', `Request aborted by caller`);
      }
      // Native fetch AbortError without HttpClientError wrapper = timeout.
      if (error instanceof Error && error.name === 'AbortError') {
        throw new McaHttpError(504, 'TIMEOUT', `Request timeout: ${error.message}`);
      }
      throw new McaHttpError(500, 'UNKNOWN_ERROR', String(error));
    }
  }

  // ==========================================================================
  // GETTERS
  // ==========================================================================

  get baseUrl(): string {
    return this.config.baseUrl;
  }
}

// ============================================================================
// ERROR CLASS
// ============================================================================

export class McaHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly response?: McaErrorResponse,
  ) {
    super(message);
    this.name = 'McaHttpError';
  }

  get isRetryable(): boolean {
    return [503, 504, 429].includes(this.statusCode);
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create an HTTP client for an MCA service
 */
export function createMcaHttpClient(
  baseUrl: string,
  options?: Partial<McaHttpClientConfig>,
): McaHttpClient {
  return new McaHttpClient({
    baseUrl,
    ...options,
  });
}
