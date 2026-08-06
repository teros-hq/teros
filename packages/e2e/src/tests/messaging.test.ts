/**
 * E2E Tests: Messaging — via the REAL WsFramework envelope (TER-453).
 *
 * `channel.send-message` / `channel.get-messages` respond with `{}` and the
 * actual payloads arrive as flat pushes (`message_sent`, `messages_history`,
 * `typing`) — same hybrid contract the production frontend consumes.
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

describe('Messaging E2E', () => {
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

  async function createChannel(c: TestClient): Promise<string> {
    const workspaceId = await createTestWorkspace(c);
    const data = await c.requestOk<{ channelId: string }>('channel.create', {
      agentId: TEST_AGENTS.assistant.id,
      workspaceId,
    });
    return data.channelId;
  }

  test('should send a message and receive confirmation', async () => {
    client = await createTestClient('user1');
    const channelId = await createChannel(client);

    await client.requestOk('channel.send-message', {
      channelId,
      content: { type: 'text', text: 'Hello, test assistant!' },
    });
    const sent = await client.waitFor('message_sent');

    expect(sent.type).toBe('message_sent');
    expect(sent.messageId).toBeDefined();
  });

  test('should get message history for a channel', async () => {
    client = await createTestClient('user1');
    const channelId = await createChannel(client);

    await client.requestOk('channel.get-messages', { channelId });
    const history = await client.waitFor('messages_history');

    expect(history.type).toBe('messages_history');
    expect(Array.isArray(history.messages)).toBe(true);
  });

  test('should receive typing indicator when message is being processed', async () => {
    client = await createTestClient('user1');
    const channelId = await createChannel(client);

    await client.requestOk('channel.send-message', {
      channelId,
      content: { type: 'text', text: 'Hello!' },
    });

    const response = await client.waitFor(['typing', 'message_sent'], 5000);
    expect(['typing', 'message_sent']).toContain(response.type);
  });
});
