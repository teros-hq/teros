/**
 * E2E Tests: Channels
 *
 * Tests for channel (conversation) management:
 * - Create channel
 * - List channels
 * - Close channel
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { E2E_CONFIG, TEST_AGENTS, TEST_USERS } from '../fixtures/test-data';
import { cleanupTestData, createTestClient, globalSetup, globalTeardown } from '../utils/setup';
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

    const response = await client.sendAndWait(
      {
        type: 'create_channel',
        agentId: TEST_AGENTS.assistant.id,
      },
      ['channel_created', 'error'],
    );

    expect(response.type).toBe('channel_created');
    expect(response.channelId).toBeDefined();
    expect(response.channelId).toMatch(/^ch_/);
    expect(response.agentId).toBe(TEST_AGENTS.assistant.id);
  });

  test('should list user channels', async () => {
    client = await createTestClient('user1');

    // Create a channel first
    await client.sendAndWait(
      {
        type: 'create_channel',
        agentId: TEST_AGENTS.assistant.id,
      },
      'channel_created',
    );

    // List channels
    const response = await client.sendAndWait({ type: 'list_channels' }, 'channels_list');

    expect(response.type).toBe('channels_list');
    expect(response.channels).toBeDefined();
    expect(Array.isArray(response.channels)).toBe(true);
    expect(response.channels.length).toBeGreaterThan(0);
  });

  test('should close a channel', async () => {
    // Use a fresh client to avoid message queue issues
    client = await createTestClient('user1');

    // Create a channel
    const createResponse = await client.sendAndWait(
      {
        type: 'create_channel',
        agentId: TEST_AGENTS.assistant.id,
      },
      'channel_created',
    );
    const channelId = createResponse.channelId;

    // Disconnect and create fresh client to clear all state
    await client.disconnect();
    client = await createTestClient('user1');

    // Close the channel
    client.send({
      type: 'close_channel',
      channelId,
    });

    // Wait for the deleted status message
    const closeResponse = await client.waitFor(['channel_list_status', 'error'], 5000);

    expect(closeResponse.type).toBe('channel_list_status');
    expect(closeResponse.channelId).toBe(channelId);
    expect(closeResponse.action).toBe('deleted');
  });
});
