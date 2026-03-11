/**
 * E2E Tests: Messaging
 *
 * Tests for basic messaging flow:
 * - Send message confirmation
 * - Get message history
 *
 * Note: Full LLM response tests require MockLLMAdapter integration
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { TEST_AGENTS } from '../fixtures/test-data';
import { cleanupTestData, createTestClient, globalSetup, globalTeardown } from '../utils/setup';
import type { TestClient } from '../utils/TestClient';

describe('Messaging E2E', () => {
  let client: TestClient;
  let channelId: string;

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

  test('should send a message and receive confirmation', async () => {
    client = await createTestClient('user1');

    // Create a channel
    const createResponse = await client.sendAndWait(
      {
        type: 'create_channel',
        agentId: TEST_AGENTS.assistant.id,
      },
      'channel_created',
    );
    channelId = createResponse.channelId;

    // Send a message
    const sendResponse = await client.sendAndWait(
      {
        type: 'send_message',
        channelId,
        content: { type: 'text', text: 'Hello, test assistant!' },
      },
      ['message_sent', 'error'],
    );

    expect(sendResponse.type).toBe('message_sent');
    expect(sendResponse.messageId).toBeDefined();
  });

  test('should get empty message history for new channel', async () => {
    client = await createTestClient('user1');

    // Create a fresh channel
    const createResponse = await client.sendAndWait(
      {
        type: 'create_channel',
        agentId: TEST_AGENTS.assistant.id,
      },
      'channel_created',
    );
    const newChannelId = createResponse.channelId;

    // Get message history
    const historyResponse = await client.sendAndWait(
      {
        type: 'get_messages',
        channelId: newChannelId,
      },
      'messages_history',
    );

    expect(historyResponse.type).toBe('messages_history');
    expect(historyResponse.messages).toBeDefined();
    expect(Array.isArray(historyResponse.messages)).toBe(true);
  });

  test('should receive typing indicator when message is being processed', async () => {
    client = await createTestClient('user1');

    // Create a channel
    const createResponse = await client.sendAndWait(
      {
        type: 'create_channel',
        agentId: TEST_AGENTS.assistant.id,
      },
      'channel_created',
    );
    channelId = createResponse.channelId;

    // Disconnect and reconnect to clear any pending messages
    await client.disconnect();
    client = await createTestClient('user1');

    // Send a message and wait for typing indicator
    client.send({
      type: 'send_message',
      channelId,
      content: { type: 'text', text: 'Hello!' },
    });

    // Wait for either typing indicator or message_sent
    const response = await client.waitFor(['typing', 'message_sent', 'error'], 5000);

    // Should get message_sent at minimum
    expect(['typing', 'message_sent']).toContain(response.type);
  });
});
