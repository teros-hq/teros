/**
 * E2E Tests for Teros Backend
 *
 * Tests the full flow from WebSocket API to LLM (mocked) responses.
 * Uses the recording system to mock third-party calls.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createSimpleMockAdapter } from '@teros/core';
import { createTestServer, type TestServerInstance } from './TestServer';

describe('Teros Backend E2E Tests', () => {
  let server: TestServerInstance;

  beforeAll(async () => {
    server = await createTestServer({
      mockResponses: [
        { text: 'Hello! I am Iria, your AI assistant. How can I help you today?' },
        { text: 'I can help with many things! What would you like to know?' },
        { text: 'Goodbye! Have a great day!' },
      ],
    });
    await server.seedAgents();
  });

  afterAll(async () => {
    await server.close();
  });

  describe('Authentication', () => {
    it('should authenticate with valid credentials', async () => {
      const client = await server.createClient();

      try {
        const { userId, sessionToken } = await client.authenticate('test@example.com', 'password');

        expect(userId).toMatch(/^user:/);
        expect(sessionToken).toBeTruthy();
      } finally {
        client.close();
      }
    });

    it('should reject invalid credentials', async () => {
      const client = await server.createClient();

      try {
        // Send auth with invalid password
        client.send({
          type: 'auth',
          method: 'credentials',
          email: '', // Empty email should fail validation
          password: 'x',
        });

        const response = await client.waitFor('auth_error');
        expect(response.type).toBe('auth_error');
      } finally {
        client.close();
      }
    });

    it('should require authentication for protected endpoints', async () => {
      const client = await server.createClient();

      try {
        // Try to list channels without auth
        client.send({ type: 'list_channels' });

        const response = await client.waitFor('error');
        expect(response.code).toBe('UNAUTHORIZED');
      } finally {
        client.close();
      }
    });
  });

  describe('Agent Listing', () => {
    it('should list available agents', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({ type: 'list_agents' });

        const response = await client.waitFor('agents_list');
        expect(response.agents).toBeArray();
        expect(response.agents.length).toBeGreaterThanOrEqual(2);

        const agentIds = response.agents.map((a: any) => a.agentId);
        expect(agentIds).toContain('agent:iria');
        expect(agentIds).toContain('agent:test');
      } finally {
        client.close();
      }
    });
  });

  describe('Channel Management', () => {
    it('should create a new channel with an agent', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({
          type: 'create_channel',
          agentId: 'agent:test',
          metadata: {
            transport: 'websocket',
          },
        });

        const response = await client.waitFor('channel_created');
        expect(response.channelId).toBeTruthy();
        expect(response.agentId).toBe('agent:test');
      } finally {
        client.close();
      }
    });

    it('should list user channels', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        // Create a channel first
        client.send({
          type: 'create_channel',
          agentId: 'agent:test',
        });
        await client.waitFor('channel_created');

        // List channels
        client.send({ type: 'list_channels' });

        const response = await client.waitFor('channels_list');
        expect(response.channels).toBeArray();
        expect(response.channels.length).toBeGreaterThanOrEqual(1);
      } finally {
        client.close();
      }
    });

    it('should get channel details', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        // Create a channel
        client.send({
          type: 'create_channel',
          agentId: 'agent:test',
        });
        const createResponse = await client.waitFor('channel_created');
        const channelId = createResponse.channelId;

        // Get channel details
        client.send({
          type: 'get_channel',
          channelId,
        });

        const response = await client.waitFor('channel_details');
        expect(response.channel.channelId).toBe(channelId);
        expect(response.channel.agentId).toBe('agent:test');
      } finally {
        client.close();
      }
    });

    it('should close a channel', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        // Create a channel
        client.send({
          type: 'create_channel',
          agentId: 'agent:test',
        });
        const createResponse = await client.waitFor('channel_created');
        const channelId = createResponse.channelId;

        // Close channel
        client.send({
          type: 'close_channel',
          channelId,
        });

        const response = await client.waitFor('channel_closed');
        expect(response.channelId).toBe(channelId);
      } finally {
        client.close();
      }
    });
  });

  describe('Messaging', () => {
    it('should send a message and receive acknowledgment', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        // Create channel
        client.send({
          type: 'create_channel',
          agentId: 'agent:test',
        });
        const createResponse = await client.waitFor('channel_created');
        const channelId = createResponse.channelId;

        // Subscribe to channel
        client.send({
          type: 'subscribe_channel',
          channelId,
        });

        // Send message
        client.send({
          type: 'send_message',
          channelId,
          content: {
            type: 'text',
            text: 'Hello, agent!',
          },
        });

        // Should receive message_sent acknowledgment
        const ackResponse = await client.waitFor('message_sent');
        expect(ackResponse.messageId).toBeTruthy();
        expect(ackResponse.timestamp).toBeTruthy();
      } finally {
        client.close();
      }
    });

    it('should receive agent response after sending message', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        // Create channel
        client.send({
          type: 'create_channel',
          agentId: 'agent:test',
        });
        const createResponse = await client.waitFor('channel_created');
        const channelId = createResponse.channelId;

        // Subscribe to channel
        client.send({
          type: 'subscribe_channel',
          channelId,
        });

        // Send message
        client.send({
          type: 'send_message',
          channelId,
          content: {
            type: 'text',
            text: 'Hello!',
          },
        });

        // Wait for acknowledgment
        await client.waitFor('message_sent');

        // Wait for user message broadcast
        const userBroadcast = await client.waitFor(
          (msg) => msg.type === 'message.send' && msg.data?.participantType === 'user',
        );
        expect(userBroadcast.data.text).toBe('Hello!');

        // May receive typing indicator first
        // Wait for agent response
        const agentResponse = await client.waitFor(
          (msg) => msg.type === 'message.send' && msg.data?.participantType === 'agent',
          10000, // Longer timeout for LLM processing
        );

        expect(agentResponse.channelId).toBe(channelId);
        expect(agentResponse.data.participantType).toBe('agent');
        expect(agentResponse.data.text).toBeTruthy();
        expect(agentResponse.data.text).toContain('Iria');
      } finally {
        client.close();
      }
    });

    it('should get message history', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        // Create channel
        client.send({
          type: 'create_channel',
          agentId: 'agent:test',
        });
        const createResponse = await client.waitFor('channel_created');
        const channelId = createResponse.channelId;

        // Subscribe and send message
        client.send({
          type: 'subscribe_channel',
          channelId,
        });

        client.send({
          type: 'send_message',
          channelId,
          content: { type: 'text', text: 'First message' },
        });

        // Wait for message to be saved
        await client.waitFor('message_sent');

        // Get message history
        client.send({
          type: 'get_messages',
          channelId,
          limit: 50,
        });

        const historyResponse = await client.waitFor('messages_history');
        expect(historyResponse.channelId).toBe(channelId);
        expect(historyResponse.messages).toBeArray();
        expect(historyResponse.messages.length).toBeGreaterThanOrEqual(1);
      } finally {
        client.close();
      }
    });
  });

  describe('Subscription Management', () => {
    it('should subscribe and unsubscribe from channels', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        // Create channel
        client.send({
          type: 'create_channel',
          agentId: 'agent:test',
        });
        const createResponse = await client.waitFor('channel_created');
        const channelId = createResponse.channelId;

        // Subscribe
        client.send({
          type: 'subscribe_channel',
          channelId,
        });

        // Unsubscribe
        client.send({
          type: 'unsubscribe_channel',
          channelId,
        });

        // These operations don't send responses, but shouldn't error
        // Verify by trying to send a message (which should still work)
        client.send({
          type: 'send_message',
          channelId,
          content: { type: 'text', text: 'Test' },
        });

        const ack = await client.waitFor('message_sent');
        expect(ack.messageId).toBeTruthy();
      } finally {
        client.close();
      }
    });
  });

  describe('Error Handling', () => {
    it('should return error for non-existent channel', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({
          type: 'get_channel',
          channelId: 'non-existent-channel-id',
        });

        const response = await client.waitFor('error');
        expect(response.code).toBe('CHANNEL_NOT_FOUND');
      } finally {
        client.close();
      }
    });

    it('should return error for sending message to non-existent channel', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({
          type: 'send_message',
          channelId: 'fake-channel-id',
          content: { type: 'text', text: 'Hello' },
        });

        const response = await client.waitFor('error');
        expect(response.code).toBe('CHANNEL_NOT_FOUND');
      } finally {
        client.close();
      }
    });
  });
});

describe('LLM Recording Tests', () => {
  it('should replay recorded responses', async () => {
    // Create server with specific mock responses
    const server = await createTestServer({
      mockResponses: [
        { text: 'Custom recorded response #1' },
        { text: 'Custom recorded response #2' },
      ],
    });

    try {
      await server.seedAgents();

      const client = await server.createClient();
      await client.authenticate();

      // Create channel
      client.send({
        type: 'create_channel',
        agentId: 'agent:test',
      });
      const { channelId } = await client.waitFor('channel_created');

      // Subscribe
      client.send({ type: 'subscribe_channel', channelId });

      // First message
      client.send({
        type: 'send_message',
        channelId,
        content: { type: 'text', text: 'First query' },
      });
      await client.waitFor('message_sent');

      // Wait for agent response
      const response1 = await client.waitFor(
        (msg) => msg.type === 'message.send' && msg.data?.participantType === 'agent',
        10000,
      );
      expect(response1.data.text).toContain('Custom recorded response #1');

      // Second message
      client.send({
        type: 'send_message',
        channelId,
        content: { type: 'text', text: 'Second query' },
      });
      await client.waitFor('message_sent');

      // Wait for second agent response
      const response2 = await client.waitFor(
        (msg) => msg.type === 'message.send' && msg.data?.participantType === 'agent',
        10000,
      );
      expect(response2.data.text).toContain('Custom recorded response #2');

      client.close();
    } finally {
      await server.close();
    }
  });
});
