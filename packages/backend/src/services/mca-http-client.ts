/**
 * MCA HTTP Client
 *
 * Client for communicating with MCAs running as HTTP services.
 * Used by McaManager to call containerized MCAs.
 *
 * @see docs/RFC-001-mca-protocol.md
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
}

// ============================================================================
// HTTP CLIENT
// ============================================================================

export class McaHttpClient {
  private config: Required<McaHttpClientConfig>;

  constructor(config: McaHttpClientConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ''), // Remove trailing slash
      timeout: config.timeout ?? 120000,
      maxRetries: config.maxRetries ?? 3,
    };
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

    const response = await this.post<McaToolResultResponse>('/tools/call', request, timeout);
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

  private async get<T>(path: string, timeout?: number): Promise<T> {
    return this.request<T>('GET', path, undefined, timeout);
  }

  private async post<T>(path: string, body: unknown, timeout?: number): Promise<T> {
    return this.request<T>('POST', path, body, timeout);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeout?: number,
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout ?? this.config.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        let errorData: McaErrorResponse | undefined;
        try {
          errorData = JSON.parse(errorBody);
        } catch {
          // Not JSON
        }

        throw new McaHttpError(
          response.status,
          errorData?.error?.code || 'HTTP_ERROR',
          errorData?.error?.message || `HTTP ${response.status}: ${response.statusText}`,
          errorData,
        );
      }

      return (await response.json()) as T;
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (error instanceof McaHttpError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new McaHttpError(
            504,
            'TIMEOUT',
            `Request timeout after ${timeout ?? this.config.timeout}ms`,
          );
        }
        throw new McaHttpError(503, 'CONNECTION_FAILED', error.message);
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
