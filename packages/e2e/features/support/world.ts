import { type IWorldOptions, setWorldConstructor, World } from '@cucumber/cucumber';
import { E2E_CONFIG } from '../../src/fixtures/test-data';
import { TestClient } from '../../src/utils/TestClient';

export interface TerosWorld extends World {
  client: TestClient | null;
  lastResponse: any;
  channelId: string | null;
  sessionToken: string | null;
  userId: string | null;
}

export class CustomWorld extends World implements TerosWorld {
  client: TestClient | null = null;
  lastResponse: any = null;
  channelId: string | null = null;
  sessionToken: string | null = null;
  userId: string | null = null;

  constructor(options: IWorldOptions) {
    super(options);
  }

  async createClient(): Promise<TestClient> {
    this.client = new TestClient({
      url: E2E_CONFIG.wsUrl,
      timeout: E2E_CONFIG.timeout,
      debug: E2E_CONFIG.debug,
    });
    await this.client.connect();
    return this.client;
  }

  async cleanup(): Promise<void> {
    if (this.client?.isConnected()) {
      await this.client.disconnect();
    }
    this.client = null;
    this.lastResponse = null;
    this.channelId = null;
    this.sessionToken = null;
    this.userId = null;
  }
}

setWorldConstructor(CustomWorld);
