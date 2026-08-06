import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  createMcaTestEnv,
  expectToolResponseShape,
  expectToolSuccess,
  SkipTracker,
  type McaTestEnvironment,
} from '@teros/mca-testing';

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const SLACK_ACCESS_TOKEN = process.env.SLACK_ACCESS_TOKEN;
const SLACK_BOT_ACCESS_TOKEN = process.env.SLACK_BOT_ACCESS_TOKEN;
const SLACK_TEST_CHANNEL = process.env.SLACK_TEST_CHANNEL;

if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET || !SLACK_ACCESS_TOKEN) {
  throw new Error(
    'Slack credentials required for integration tests. ' +
    'Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_ACCESS_TOKEN ' +
    '(and optionally SLACK_BOT_ACCESS_TOKEN, SLACK_TEST_CHANNEL) in .env.test.',
  );
}

let env: McaTestEnvironment;
const skipTracker = new SkipTracker(3);

function setSlackSecrets(): void {
  env.mockBackend.setSystemSecrets({
    CLIENT_ID: SLACK_CLIENT_ID!,
    CLIENT_SECRET: SLACK_CLIENT_SECRET!,
  });
  env.mockBackend.setUserSecrets({
    ACCESS_TOKEN: SLACK_ACCESS_TOKEN!,
    BOT_ACCESS_TOKEN: SLACK_BOT_ACCESS_TOKEN ?? '',
  });
}

beforeAll(async () => {
  env = createMcaTestEnv({ mcaId: 'mca.slack' });
  await env.start();
  setSlackSecrets();
}, 120_000);

afterAll(async () => {
  await env.stop();
  skipTracker.assertNotTooManySkips();
}, 30_000);

beforeEach(() => {
  env.mockBackend.reset();
  setSlackSecrets();
});

// ─── Health Check with Real Credentials ────────────────────────────────────

describe('Health Check', () => {
  it('reports ready with valid OAuth credentials', async () => {
    const result = await env.mcaClient.callTool('-health-check', {});

    expect(result.success).toBe(true);
    const data = result.result as { status: string };
    expect(data.status).toBe('ready');
  }, 30_000);
});

// ─── List Channels ─────────────────────────────────────────────────────────

describe('list-channels', () => {
  it('lists public channels', async () => {
    const result = await env.mcaClient.callTool('list-channels', {
      types: 'public_channel',
      limit: 5,
    });

    expectToolSuccess(result);
    const data = result.result as { channels?: unknown[]; total?: number };
    expect(data.channels).toBeDefined();
    expect(Array.isArray(data.channels)).toBe(true);
  }, 30_000);

  it('paginates with cursor', async () => {
    const first = await env.mcaClient.callTool('list-channels', {
      types: 'public_channel',
      limit: 2,
    });

    expectToolSuccess(first);
    const firstData = first.result as { nextCursor?: string | null };

    if (firstData.nextCursor) {
      const second = await env.mcaClient.callTool('list-channels', {
        types: 'public_channel',
        limit: 2,
        cursor: firstData.nextCursor,
      });
      expectToolSuccess(second);
    }
  }, 30_000);
});

// ─── List Users ──────────────────────────────────────────────────────────

describe('list-users', () => {
  it('lists workspace users', async () => {
    const result = await env.mcaClient.callTool('list-users', { limit: 5 });

    expectToolSuccess(result);
    const data = result.result as { users?: unknown[] };
    expect(data.users).toBeDefined();
    expect(data.users!.length).toBeGreaterThan(0);
  }, 30_000);
});

// ─── Get User ────────────────────────────────────────────────────────────

describe('get-user', () => {
  it('fetches a user by ID from list', async () => {
    const listResult = await env.mcaClient.callTool('list-users', { limit: 1 });
    expectToolSuccess(listResult);

    const listData = listResult.result as { users?: { id: string }[] };
    if (!listData.users?.length) {
      skipTracker.skip('get-user', 'no users found');
      return;
    }

    const userId = listData.users[0].id;
    const result = await env.mcaClient.callTool('get-user', { userId });
    expectToolSuccess(result);

    const data = result.result as { id?: string };
    expect(data.id).toBe(userId);
  }, 30_000);
});

// ─── Search Messages ───────────────────────────────────────────────────────

describe('search-messages', () => {
  it('searches with query', async () => {
    const result = await env.mcaClient.callTool('search-messages', {
      query: 'test',
      count: 3,
    });

    expectToolResponseShape(result, { messages: 'array' });
  }, 30_000);
});

// ─── Messages (requires test channel) ──────────────────────────────────────

describe('Messages', () => {
  it('sends and lists messages in test channel', async () => {
    if (!SLACK_TEST_CHANNEL) {
      skipTracker.skip('send-and-list-messages', 'SLACK_TEST_CHANNEL not set');
      return;
    }

    const sendResult = await env.mcaClient.callTool('send-message', {
      channel: SLACK_TEST_CHANNEL,
      text: `[MCA Integration Test] ${Date.now()}`,
    });
    expectToolSuccess(sendResult);

    const sendData = sendResult.result as { ts?: string };
    expect(sendData.ts).toBeTruthy();

    const listResult = await env.mcaClient.callTool('list-messages', {
      channel: SLACK_TEST_CHANNEL,
      limit: 5,
    });
    expectToolSuccess(listResult);

    const listData = listResult.result as { messages?: unknown[] };
    expect(listData.messages).toBeDefined();
    expect(listData.messages!.length).toBeGreaterThan(0);
  }, 30_000);
});

// ─── Team Info ─────────────────────────────────────────────────────────────

describe('get-team-info', () => {
  it('returns workspace info', async () => {
    const result = await env.mcaClient.callTool('get-team-info', {});

    expectToolSuccess(result);
    const data = result.result as { id?: string; name?: string };
    expect(data.id).toBeTruthy();
    expect(data.name).toBeTruthy();
  }, 15_000);
});
