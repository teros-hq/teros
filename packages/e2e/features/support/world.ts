import { type IWorldOptions, setWorldConstructor, World } from '@cucumber/cucumber';
import { E2E_CONFIG } from '../../src/fixtures/test-data';
import { TestClient, type WsMessage } from '../../src/utils/TestClient';

function getWsUrl(): string {
  return process.env.E2E_WS_URL || 'ws://localhost:3002/ws';
}

export interface TerosWorld extends World {
  client: TestClient | null;
  /** Second client for cross-user realtime scenarios (TER-453). */
  clientB: TestClient | null;
  lastResponse: any;
  channelId: string | null;
  workspaceId: string | null;
  sessionToken: string | null;
  userId: string | null;
  userIdB: string | null;
  /** Pending event wait armed BEFORE the trigger (realtime cross-user). */
  pendingEvent: Promise<WsMessage> | null;
}

export class CustomWorld extends World implements TerosWorld {
  client: TestClient | null = null;
  clientB: TestClient | null = null;
  lastResponse: any = null;
  channelId: string | null = null;
  workspaceId: string | null = null;
  sessionToken: string | null = null;
  userId: string | null = null;
  userIdB: string | null = null;
  pendingEvent: Promise<WsMessage> | null = null;

  constructor(options: IWorldOptions) {
    super(options);
  }

  async createClient(): Promise<TestClient> {
    // Read the URL dynamically so it reflects the port assigned by TestServer
    // (BeforeAll sets process.env.E2E_WS_URL before any scenario runs, but
    // E2E_CONFIG is a const evaluated at module load time, so we call getWsUrl()
    // directly here instead).
    this.client = new TestClient({
      url: getWsUrl(),
      timeout: E2E_CONFIG.timeout,
      debug: E2E_CONFIG.debug,
    });
    await this.client.connect();
    return this.client;
  }

  async createClientB(): Promise<TestClient> {
    this.clientB = new TestClient({
      url: getWsUrl(),
      timeout: E2E_CONFIG.timeout,
      debug: E2E_CONFIG.debug,
    });
    await this.clientB.connect();
    return this.clientB;
  }

  async cleanup(): Promise<void> {
    if (this.client?.isConnected()) {
      await this.client.disconnect();
    }
    if (this.clientB?.isConnected()) {
      await this.clientB.disconnect();
    }
    this.client = null;
    this.clientB = null;
    this.lastResponse = null;
    this.channelId = null;
    this.workspaceId = null;
    this.sessionToken = null;
    this.userId = null;
    this.userIdB = null;
    this.pendingEvent = null;
  }
}

setWorldConstructor(CustomWorld);
