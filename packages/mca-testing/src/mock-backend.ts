import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';

export interface MockBackendConfig {
  port?: number;
  callbackToken?: string;
}

export interface ReceivedEvent {
  event: string;
  payload: unknown;
  targetChannelId?: string;
  timestamp: string;
}

export interface ReceivedAuthError {
  error: string;
  message?: string;
  canRetry: boolean;
  timestamp: string;
}

interface DataStore {
  [key: string]: { value: unknown; updatedAt: string };
}

export class MockBackendServer {
  private server: Server | null = null;
  private port: number;
  private callbackToken: string;

  private systemSecrets: Record<string, string> = {};
  private userSecrets: Record<string, string> = {};
  private secretError: { status: number; message: string } | null = null;

  private receivedEvents: ReceivedEvent[] = [];
  private receivedAuthErrors: ReceivedAuthError[] = [];
  private secretRequests: { type: 'system' | 'user'; timestamp: string }[] = [];
  private dataStore: DataStore = {};
  private updatedUserSecrets: Record<string, string>[] = [];

  constructor(config: MockBackendConfig = {}) {
    this.port = config.port ?? 9900;
    this.callbackToken = config.callbackToken ?? 'test-callback-token';
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.on('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[MockBackend] Listening on :${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  getUrl(): string {
    return `http://localhost:${this.port}`;
  }

  getPort(): number {
    return this.port;
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  setSystemSecrets(secrets: Record<string, string>): void {
    this.systemSecrets = { ...secrets };
  }

  setUserSecrets(secrets: Record<string, string>): void {
    this.userSecrets = { ...secrets };
  }

  setSecretError(status: number, message: string): void {
    this.secretError = { status, message };
  }

  clearSecretError(): void {
    this.secretError = null;
  }

  // ── Introspection ──────────────────────────────────────────────────────────

  getReceivedEvents(): ReceivedEvent[] {
    return [...this.receivedEvents];
  }

  getReceivedAuthErrors(): ReceivedAuthError[] {
    return [...this.receivedAuthErrors];
  }

  getSecretRequests(): { type: 'system' | 'user'; timestamp: string }[] {
    return [...this.secretRequests];
  }

  getUpdatedUserSecrets(): Record<string, string>[] {
    return [...this.updatedUserSecrets];
  }

  getDataStore(): DataStore {
    return { ...this.dataStore };
  }

  reset(): void {
    this.systemSecrets = {};
    this.userSecrets = {};
    this.secretError = null;
    this.receivedEvents = [];
    this.receivedAuthErrors = [];
    this.secretRequests = [];
    this.dataStore = {};
    this.updatedUserSecrets = [];
  }

  // ── Request Handling ───────────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || '/';
    const method = req.method || 'GET';

    res.setHeader('Content-Type', 'application/json');

    if (method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!this.validateAuth(req)) {
      this.sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const body = await this.readBody(req);

    if (url === '/secrets/system') {
      this.handleSystemSecrets(res);
    } else if (url === '/secrets/user') {
      this.handleUserSecrets(res);
    } else if (url === '/secrets/user/update') {
      this.handleUpdateUserSecrets(res, body);
    } else if (url === '/events') {
      this.handleEmitEvent(res, body);
    } else if (url === '/auth/error') {
      this.handleAuthError(res, body);
    } else if (url === '/auth/url') {
      this.handleAuthUrl(res);
    } else if (url === '/health') {
      this.handleHealth(res);
    } else if (url === '/ui/ready') {
      this.sendJson(res, 200, { acknowledged: true });
    } else if (url === '/ui/action') {
      this.sendJson(res, 200, { handled: true });
    } else if (url === '/approval/request') {
      this.sendJson(res, 200, { pending: false, approvalId: 'test-approval' });
    } else if (url === '/agent/message') {
      this.sendJson(res, 200, {});
    } else if (url === '/agent/complete') {
      this.sendJson(res, 200, {});
    } else if (url === '/agent/tool') {
      this.sendJson(res, 200, { result: null });
    } else if (url === '/subscriptions/channel') {
      this.handleSubscription(res, body);
    } else if (url.startsWith('/data/')) {
      this.handleData(res, url, body);
    } else if (url.startsWith('/resources/')) {
      this.handleResources(res);
    } else {
      this.sendJson(res, 404, { error: `Unknown endpoint: ${url}` });
    }
  }

  private handleSystemSecrets(res: ServerResponse): void {
    this.secretRequests.push({ type: 'system', timestamp: new Date().toISOString() });
    if (this.secretError) {
      this.sendJson(res, this.secretError.status, { error: this.secretError.message });
      return;
    }
    this.sendJson(res, 200, { secrets: this.systemSecrets });
  }

  private handleUserSecrets(res: ServerResponse): void {
    this.secretRequests.push({ type: 'user', timestamp: new Date().toISOString() });
    if (this.secretError) {
      this.sendJson(res, this.secretError.status, { error: this.secretError.message });
      return;
    }
    const hasSecrets = Object.keys(this.userSecrets).length > 0;
    this.sendJson(res, 200, {
      secrets: this.userSecrets,
      authenticated: hasSecrets,
    });
  }

  private handleUpdateUserSecrets(res: ServerResponse, body: Record<string, unknown>): void {
    const secrets = body.secrets as Record<string, string> | undefined;
    if (secrets) {
      this.updatedUserSecrets.push(secrets);
      Object.assign(this.userSecrets, secrets);
    }
    this.sendJson(res, 200, { success: true });
  }

  private handleEmitEvent(res: ServerResponse, body: Record<string, unknown>): void {
    this.receivedEvents.push({
      event: body.event as string,
      payload: body.payload,
      targetChannelId: body.targetChannelId as string | undefined,
      timestamp: new Date().toISOString(),
    });
    this.sendJson(res, 200, { delivered: true, recipientCount: 1 });
  }

  private handleAuthError(res: ServerResponse, body: Record<string, unknown>): void {
    this.receivedAuthErrors.push({
      error: body.error as string,
      message: body.message as string | undefined,
      canRetry: body.canRetry as boolean,
      timestamp: new Date().toISOString(),
    });
    this.sendJson(res, 200, { action: 'retry' });
  }

  private handleAuthUrl(res: ServerResponse): void {
    this.sendJson(res, 200, {
      url: 'https://mock-auth.test/authorize?state=test-state',
      state: 'test-state',
    });
  }

  private handleHealth(res: ServerResponse): void {
    this.sendJson(res, 200, { success: true });
  }

  private handleSubscription(res: ServerResponse, body: Record<string, unknown>): void {
    const action = body.action as string;
    if (action === 'create') {
      this.sendJson(res, 200, {
        success: true,
        subscription: {
          id: 'sub-test-1',
          topic: body.topic,
          channelId: body.channelId || 'channel:test',
          mode: body.mode || 'notify',
        },
      });
    } else if (action === 'delete') {
      this.sendJson(res, 200, { success: true, deleted: true });
    } else if (action === 'delete-by-topic') {
      this.sendJson(res, 200, { success: true, deletedCount: 1 });
    } else {
      this.sendJson(res, 400, { error: `Unknown subscription action: ${action}` });
    }
  }

  private handleData(res: ServerResponse, url: string, body: Record<string, unknown>): void {
    if (url === '/data/_list') {
      const scope = body.scope as string;
      const keys = Object.entries(this.dataStore)
        .filter(([k]) => k.startsWith(`${scope}:`))
        .map(([key, val]) => ({ key: key.replace(`${scope}:`, ''), updatedAt: val.updatedAt }));
      this.sendJson(res, 200, { keys });
      return;
    }

    const key = url.replace('/data/', '');
    const action = body.action as string;
    const scope = body.scope as string;
    const scopedKey = `${scope}:${key}`;

    if (action === 'get') {
      const entry = this.dataStore[scopedKey];
      this.sendJson(res, 200, { value: entry?.value ?? null, exists: !!entry });
    } else if (action === 'set') {
      this.dataStore[scopedKey] = { value: body.value, updatedAt: new Date().toISOString() };
      this.sendJson(res, 200, { success: true });
    } else if (action === 'delete') {
      const existed = !!this.dataStore[scopedKey];
      delete this.dataStore[scopedKey];
      this.sendJson(res, 200, { success: true, deleted: existed });
    } else {
      this.sendJson(res, 400, { error: `Unknown data action: ${action}` });
    }
  }

  private handleResources(res: ServerResponse): void {
    this.sendJson(res, 200, { agents: [], workspaces: [], apps: [], catalog: [], skills: [] });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private validateAuth(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (!auth) return true;
    return auth === `Bearer ${this.callbackToken}`;
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      });
    });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status);
    res.end(JSON.stringify(body));
  }
}
