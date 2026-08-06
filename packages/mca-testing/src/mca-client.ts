import type {
  McaExecutionContext,
  McaHealthStatusResponse,
  McaToolCallRequest,
  McaToolResultResponse,
  McaToolsListResponse,
} from '@teros/shared';
import { generateMessageId, MCA_PROTOCOL_VERSION } from '@teros/shared';

export interface McaTestClientConfig {
  baseUrl: string;
  callbackUrl: string;
  callbackToken?: string;
  timeout?: number;
  defaultContext?: Partial<McaExecutionContext>;
}

export class McaTestClient {
  private baseUrl: string;
  private callbackUrl: string;
  private callbackToken: string;
  private timeout: number;
  private defaultContext: Partial<McaExecutionContext>;

  constructor(config: McaTestClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.callbackUrl = config.callbackUrl;
    this.callbackToken = config.callbackToken ?? 'test-callback-token';
    this.timeout = config.timeout ?? 30_000;
    this.defaultContext = config.defaultContext ?? {};
  }

  async health(): Promise<McaHealthStatusResponse> {
    const res = await this.fetch('/health', { method: 'GET' });
    return res.json();
  }

  async listTools(): Promise<McaToolsListResponse> {
    const res = await this.fetch('/tools/list', { method: 'GET' });
    return res.json();
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    contextOverrides?: Partial<McaExecutionContext>,
  ): Promise<McaToolResultResponse> {
    const context: McaExecutionContext = {
      userId: 'user:test_user',
      appId: 'app:test_app',
      mcaId: 'mca.test',
      channelId: 'channel:test',
      agentId: 'agent:test',
      workspaceId: 'workspace:test',
      requestId: generateMessageId(),
      callbackUrl: this.callbackUrl,
      ...this.defaultContext,
      ...contextOverrides,
    };

    const request: McaToolCallRequest = {
      id: generateMessageId(),
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      version: MCA_PROTOCOL_VERSION,
      tool: name,
      arguments: args,
      context,
    };

    const res = await this.fetch('/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    return res.json();
  }

  async shutdown(): Promise<void> {
    await this.fetch('/shutdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: generateMessageId(),
        type: 'shutdown',
        timestamp: new Date().toISOString(),
        version: MCA_PROTOCOL_VERSION,
        gracePeriod: 5000,
      }),
    });
  }

  async waitForHealthy(timeoutMs: number = 60_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const health = await this.health();
        if (health.status === 'ready') return;
      } catch {
        // MCA not up yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`MCA not healthy after ${timeoutMs}ms`);
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }
}
