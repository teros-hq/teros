/**
 * E2E Tests: Channels — via the REAL WsFramework envelope (TER-453).
 *
 * Requires an external backend on E2E_CONFIG.wsUrl (this is the
 * against-real-backend lane; the self-contained lane is
 * smoke.acceptance.test.ts + the Cucumber features).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { TEST_AGENTS } from '../fixtures/test-data';
import {
  cleanupTestData,
  createTestClient,
  createTestWorkspace,
  globalSetup,
  globalTeardown,
} from '../utils/setup';
import type { TestClient } from '../utils/TestClient';

describe('Channels E2E', () => {
  let client: TestClient;

  beforeAll(async () => {
    await globalSetup();
    await cleanupTestData();
  });

  afterAll(async () => {
    await globalTeardown();
  });

  afterEach(async () => {
    if (client?.isConnected()) {
      await client.disconnect();
    }
  });

  test('should create a new channel', async () => {
    client = await createTestClient('user1');
    const workspaceId = await createTestWorkspace(client);

    const data = await client.requestOk<{ channelId: string; agentId: string }>('channel.create', {
      agentId: TEST_AGENTS.assistant.id,
      workspaceId,
    });

    expect(data.channelId).toMatch(/^ch_/);
    expect(data.agentId).toBe(TEST_AGENTS.assistant.id);
  });

  test('should list user channels', async () => {
    client = await createTestClient('user1');
    const workspaceId = await createTestWorkspace(client);

    await client.requestOk('channel.create', {
      agentId: TEST_AGENTS.assistant.id,
      workspaceId,
    });

    const data = await client.requestOk<{ channels: unknown[] }>('channel.list', { workspaceId });

    expect(Array.isArray(data.channels)).toBe(true);
    expect(data.channels.length).toBeGreaterThan(0);
  });

  test('should close a channel', async () => {
    client = await createTestClient('user1');
    const workspaceId = await createTestWorkspace(client);

    const created = await client.requestOk<{ channelId: string }>('channel.create', {
      agentId: TEST_AGENTS.assistant.id,
      workspaceId,
    });

    const closed = await client.requestOk<{ channelId: string; status: string }>('channel.close', {
      channelId: created.channelId,
    });

    expect(closed).toEqual({ channelId: created.channelId, status: 'closed' });
  });
});
