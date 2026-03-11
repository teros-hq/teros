/**
 * API Tests - Feature-based API testing
 *
 * Tests the WebSocket API following the BDD feature scenarios in docs/features/.
 * These tests validate the API contract from an external perspective.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestServer, type TestServerInstance } from './TestServer';

describe('Teros API Tests (Feature-based)', () => {
  let server: TestServerInstance;

  beforeAll(async () => {
    server = await createTestServer({
      mockResponses: [
        { text: 'Hello! How can I help you today?' },
        { text: 'Sure, I can help with that.' },
        { text: 'Here is your response.' },
        { text: 'Anything else I can help with?' },
        { text: 'Goodbye!' },
      ],
    });
    await server.seedAgents();
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  describe('Feature 01: Authentication', () => {
    it('should authenticate with email and password', async () => {
      const client = await server.createClient();

      try {
        const { userId, sessionToken } = await client.authenticate('pablo@teros.ai', 'password123');

        expect(userId).toMatch(/^user:/);
        expect(sessionToken).toMatch(/^token_/);
        expect(sessionToken).toContain(userId);
      } finally {
        client.close();
      }
    });

    it('should authenticate with session token', async () => {
      const client1 = await server.createClient();

      try {
        // First auth to get token
        const { sessionToken } = await client1.authenticate('pablo@teros.ai', 'password123');

        // Create new client and auth with token
        const client2 = await server.createClient();

        try {
          client2.send({
            type: 'auth',
            method: 'token',
            sessionToken,
          });

          const response = await client2.waitFor('auth_success');
          expect(response.type).toBe('auth_success');
          expect(response.userId).toBeTruthy();
        } finally {
          client2.close();
        }
      } finally {
        client1.close();
      }
    });

    it('should reject invalid email format', async () => {
      const client = await server.createClient();

      try {
        client.send({
          type: 'auth',
          method: 'credentials',
          email: 'invalid-email',
          password: 'password123',
        });

        const response = await client.waitFor('auth_error');
        expect(response.type).toBe('auth_error');
        expect(response.error).toContain('Invalid');
      } finally {
        client.close();
      }
    });

    it('should require authentication for protected endpoints', async () => {
      const client = await server.createClient();

      try {
        // Try to access protected endpoint without auth
        client.send({ type: 'list_channels' });

        const response = await client.waitFor('error');
        expect(response.code).toBe('UNAUTHORIZED');
      } finally {
        client.close();
      }
    });
  });

  describe('Feature 02: Agent Discovery', () => {
    it('should list all available agents', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({ type: 'list_agents' });

        const response = await client.waitFor('agents_list');
        expect(response.agents).toBeArray();
        expect(response.agents.length).toBeGreaterThanOrEqual(2);
      } finally {
        client.close();
      }
    });

    it('should return agent metadata', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({ type: 'list_agents' });

        const response = await client.waitFor('agents_list');
        const agent = response.agents[0];

        expect(agent.agentId).toMatch(/^agent:/);
        expect(agent.name).toBeString();
        // Agent should have at least agentId and name from the API
        // Other fields (fullName, role, intro, avatarUrl) may vary
      } finally {
        client.close();
      }
    });
  });

  describe('Feature 03: Channel Management', () => {
    it('should create a new channel', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({
          type: 'create_channel',
          agentId: 'agent:iria',
        });

        const response = await client.waitFor('channel_created');
        expect(response.channelId).toMatch(/^ch[_:]/);
        expect(response.agentId).toBe('agent:iria');
      } finally {
        client.close();
      }
    });

    it('should list user channels', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        // Create a channel first
        client.send({
          type: 'create_channel',
          agentId: 'agent:iria',
        });
        const createResp = await client.waitFor('channel_created');
        const channelId = createResp.channelId;

        // List channels
        client.send({ type: 'list_channels' });

        const response = await client.waitFor('channels_list');
        expect(response.channels).toBeArray();
        expect(response.channels.length).toBeGreaterThanOrEqual(1);

        const channelIds = response.channels.map((c: any) => c.channelId);
        expect(channelIds).toContain(channelId);
      } finally {
        client.close();
      }
    });

    it('should get channel details', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({
          type: 'create_channel',
          agentId: 'agent:iria',
        });
        const createResp = await client.waitFor('channel_created');
        const channelId = createResp.channelId;

        client.send({
          type: 'get_channel',
          channelId,
        });

        const response = await client.waitFor('channel_details');
        expect(response.channel.channelId).toBe(channelId);
        expect(response.channel.agentId).toBe('agent:iria');
        expect(response.channel.userId).toBeTruthy();
      } finally {
        client.close();
      }
    });

    it('should deny access to other users channels', async () => {
      const client1 = await server.createClient();
      const client2 = await server.createClient();

      try {
        await client1.authenticate('user1@test.com', 'password');
        await client2.authenticate('user2@test.com', 'password');

        client1.send({
          type: 'create_channel',
          agentId: 'agent:iria',
        });
        const createResp = await client1.waitFor('channel_created');
        const channelId = createResp.channelId;

        // Try to access from different user
        client2.send({
          type: 'get_channel',
          channelId,
        });

        const response = await client2.waitFor('error');
        expect(response.code).toBe('UNAUTHORIZED');
      } finally {
        client1.close();
        client2.close();
      }
    });
  });

  describe('Feature 04: Channel Subscriptions', () => {
    it('should receive messages after subscription', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({
          type: 'create_channel',
          agentId: 'agent:iria',
        });
        const createResp = await client.waitFor('channel_created');
        const channelId = createResp.channelId;

        client.send({
          type: 'subscribe_channel',
          channelId,
        });

        // Send a message
        client.send({
          type: 'send_message',
          channelId,
          content: { type: 'text', text: 'Hello' },
        });

        // Wait for user message broadcast
        const userMsg = await client.waitFor(
          (msg: any) => msg.type === 'message.send' && msg.data?.participantType === 'user',
        );

        expect(userMsg.channelId).toBe(channelId);
        expect(userMsg.data.text).toBe('Hello');
      } finally {
        client.close();
      }
    });

    it('should handle multiple subscriptions', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({ type: 'create_channel', agentId: 'agent:iria' });
        const ch1 = await client.waitFor('channel_created');

        client.send({ type: 'create_channel', agentId: 'agent:test' });
        const ch2 = await client.waitFor('channel_created');

        client.send({ type: 'subscribe_channel', channelId: ch1.channelId });
        client.send({ type: 'subscribe_channel', channelId: ch2.channelId });

        // Both subscriptions should work independently
        client.send({
          type: 'send_message',
          channelId: ch1.channelId,
          content: { type: 'text', text: 'Message to channel 1' },
        });

        const msg = await client.waitFor(
          (m: any) => m.type === 'message.send' && m.channelId === ch1.channelId,
        );

        expect(msg.data.text).toBe('Message to channel 1');
      } finally {
        client.close();
      }
    });
  });

  describe('Feature 05: Basic Messaging', () => {
    it('should send a text message', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({ type: 'create_channel', agentId: 'agent:iria' });
        const createResp = await client.waitFor('channel_created');
        const channelId = createResp.channelId;

        client.send({
          type: 'send_message',
          channelId,
          content: { type: 'text', text: 'Hello Iria' },
        });

        const ack = await client.waitFor('message_sent');
        expect(ack.messageId).toMatch(/^msg[_:]/);
        expect(ack.timestamp).toBeTruthy();
      } finally {
        client.close();
      }
    });

    it('should receive agent response', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({ type: 'create_channel', agentId: 'agent:iria' });
        const createResp = await client.waitFor('channel_created');
        const channelId = createResp.channelId;

        client.send({ type: 'subscribe_channel', channelId });

        client.send({
          type: 'send_message',
          channelId,
          content: { type: 'text', text: 'Hello' },
        });

        // Skip user message
        await client.waitFor(
          (m: any) => m.type === 'message.send' && m.data?.participantType === 'user',
        );

        // Wait for agent response
        const agentMsg = await client.waitFor(
          (m: any) => m.type === 'message.send' && m.data?.participantType === 'agent',
        );

        expect(agentMsg.data.text).toBeTruthy();
        expect(agentMsg.data.agentId).toBe('agent:iria');
      } finally {
        client.close();
      }
    });

    it('should persist messages', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({ type: 'create_channel', agentId: 'agent:iria' });
        const createResp = await client.waitFor('channel_created');
        const channelId = createResp.channelId;

        client.send({ type: 'subscribe_channel', channelId });

        // Send message
        client.send({
          type: 'send_message',
          channelId,
          content: { type: 'text', text: 'Test persistence' },
        });

        // Wait for ack
        await client.waitFor('message_sent');

        // Get message history
        client.send({
          type: 'get_messages',
          channelId,
          limit: 10,
        });

        const history = await client.waitFor('messages_history');
        expect(history.messages).toBeArray();

        const userMessages = history.messages.filter((m: any) => m.role === 'user');
        expect(userMessages.length).toBeGreaterThanOrEqual(1);

        const lastUserMsg = userMessages[userMessages.length - 1];
        expect(lastUserMsg.content.text).toBe('Test persistence');
      } finally {
        client.close();
      }
    });

    it('should enforce access control', async () => {
      const client1 = await server.createClient();
      const client2 = await server.createClient();

      try {
        await client1.authenticate('user1@test.com', 'password');
        await client2.authenticate('user2@test.com', 'password');

        client1.send({ type: 'create_channel', agentId: 'agent:iria' });
        const createResp = await client1.waitFor('channel_created');
        const channelId = createResp.channelId;

        // Try to send message from different user
        client2.send({
          type: 'send_message',
          channelId,
          content: { type: 'text', text: 'Unauthorized message' },
        });

        const error = await client2.waitFor('error');
        expect(error.code).toBe('UNAUTHORIZED');
      } finally {
        client1.close();
        client2.close();
      }
    });
  });

  describe('Feature 06: Message History', () => {
    it('should retrieve message history', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({ type: 'create_channel', agentId: 'agent:iria' });
        const createResp = await client.waitFor('channel_created');
        const channelId = createResp.channelId;

        client.send({ type: 'subscribe_channel', channelId });

        // Send multiple messages
        for (let i = 1; i <= 3; i++) {
          client.send({
            type: 'send_message',
            channelId,
            content: { type: 'text', text: `Message ${i}` },
          });
          await client.waitFor('message_sent');
        }

        // Wait a bit for agent responses
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Get history
        client.send({
          type: 'get_messages',
          channelId,
          limit: 20,
        });

        const history = await client.waitFor('messages_history');
        expect(history.messages).toBeArray();
        expect(history.messages.length).toBeGreaterThanOrEqual(3);
      } finally {
        client.close();
      }
    });

    it('should respect limit parameter', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({ type: 'create_channel', agentId: 'agent:iria' });
        const createResp = await client.waitFor('channel_created');
        const channelId = createResp.channelId;

        // Send some messages first
        for (let i = 1; i <= 5; i++) {
          client.send({
            type: 'send_message',
            channelId,
            content: { type: 'text', text: `Message ${i}` },
          });
          await client.waitFor('message_sent');
        }

        // Get limited history
        client.send({
          type: 'get_messages',
          channelId,
          limit: 3,
        });

        const history = await client.waitFor('messages_history');
        expect(history.messages.length).toBeLessThanOrEqual(3);
      } finally {
        client.close();
      }
    });

    it('should enforce access control on history', async () => {
      const client1 = await server.createClient();
      const client2 = await server.createClient();

      try {
        await client1.authenticate('user1@test.com', 'password');
        await client2.authenticate('user2@test.com', 'password');

        client1.send({ type: 'create_channel', agentId: 'agent:iria' });
        const createResp = await client1.waitFor('channel_created');
        const channelId = createResp.channelId;

        // Try to get history from different user
        client2.send({
          type: 'get_messages',
          channelId,
          limit: 10,
        });

        const error = await client2.waitFor('error');
        expect(error.code).toBe('UNAUTHORIZED');
      } finally {
        client1.close();
        client2.close();
      }
    });
  });

  describe('Feature 07: Typing Indicators', () => {
    it('should receive agent typing indicator', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({ type: 'create_channel', agentId: 'agent:iria' });
        const createResp = await client.waitFor('channel_created');
        const channelId = createResp.channelId;

        client.send({ type: 'subscribe_channel', channelId });

        // Send message to trigger agent response
        client.send({
          type: 'send_message',
          channelId,
          content: { type: 'text', text: 'Hello' },
        });

        // With mock LLM, response is instant so we only get isTyping:false
        // Wait for typing stop indicator (mock response is instant)
        const typing = await client.waitFor((m: any) => m.type === 'typing');

        expect(typing.channelId).toBe(channelId);
        expect(typing.agentId).toBe('agent:iria');
        expect(typing.isTyping).toBe(false); // Mock LLM is instant
      } finally {
        client.close();
      }
    });
  });

  describe('Feature 08: Streaming Responses', () => {
    it('should send complete message after streaming', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({ type: 'create_channel', agentId: 'agent:iria' });
        const createResp = await client.waitFor('channel_created');
        const channelId = createResp.channelId;

        client.send({ type: 'subscribe_channel', channelId });

        client.send({
          type: 'send_message',
          channelId,
          content: { type: 'text', text: 'Hello' },
        });

        // Skip user message
        await client.waitFor(
          (m: any) => m.type === 'message.send' && m.data?.participantType === 'user',
        );

        // Wait for complete agent message
        const finalMsg = await client.waitFor(
          (m: any) => m.type === 'message.send' && m.data?.participantType === 'agent',
        );

        expect(finalMsg.data.messageId).toBeTruthy();
        expect(finalMsg.data.text).toBeTruthy();
        expect(finalMsg.data.timestamp).toBeTruthy();
      } finally {
        client.close();
      }
    });
  });

  describe('Feature 09: Error Handling', () => {
    it('should return error for invalid channel ID', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({
          type: 'send_message',
          channelId: 'ch:invalid-id',
          content: { type: 'text', text: 'Hello' },
        });

        const error = await client.waitFor('error');
        expect(error.code).toBe('CHANNEL_NOT_FOUND');
      } finally {
        client.close();
      }
    });

    it('should return structured error messages', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        client.send({
          type: 'get_channel',
          channelId: 'ch:does-not-exist',
        });

        const error = await client.waitFor('error');
        expect(error.type).toBe('error');
        expect(error.code).toBeString();
        expect(error.message).toBeString();
      } finally {
        client.close();
      }
    });
  });

  describe('Feature 10: Session Management', () => {
    it('should maintain session state across requests', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate('pablo@teros.ai', 'password123');

        // Create channel
        client.send({ type: 'create_channel', agentId: 'agent:iria' });
        const createResp = await client.waitFor('channel_created');
        const channelId = createResp.channelId;

        // Send multiple requests using the same session
        client.send({ type: 'list_channels' });
        await client.waitFor('channels_list');

        client.send({ type: 'get_channel', channelId });
        const details = await client.waitFor('channel_details');

        expect(details.channel.channelId).toBe(channelId);
      } finally {
        client.close();
      }
    });

    it('should support multiple concurrent sessions per user', async () => {
      const client1 = await server.createClient();
      const client2 = await server.createClient();

      try {
        // Same user, different sessions
        await client1.authenticate('pablo@teros.ai', 'password123');
        await client2.authenticate('pablo@teros.ai', 'password123');

        // Create channel in session 1
        client1.send({ type: 'create_channel', agentId: 'agent:iria' });
        const createResp = await client1.waitFor('channel_created');
        const channelId = createResp.channelId;

        // Access from session 2 (same user)
        client2.send({
          type: 'get_channel',
          channelId,
        });

        const details = await client2.waitFor('channel_details');
        expect(details.channel.channelId).toBe(channelId);
      } finally {
        client1.close();
        client2.close();
      }
    });

    it('should isolate sessions between users', async () => {
      const client1 = await server.createClient();
      const client2 = await server.createClient();

      try {
        await client1.authenticate('user1@test.com', 'password');
        await client2.authenticate('user2@test.com', 'password');

        // Create channel as user1
        client1.send({ type: 'create_channel', agentId: 'agent:iria' });
        const createResp = await client1.waitFor('channel_created');
        const channelId = createResp.channelId;

        // Try to access as user2
        client2.send({
          type: 'get_channel',
          channelId,
        });

        const error = await client2.waitFor('error');
        expect(error.code).toBe('UNAUTHORIZED');
      } finally {
        client1.close();
        client2.close();
      }
    });
  });
});
