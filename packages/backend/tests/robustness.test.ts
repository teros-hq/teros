/**
 * Robustness Tests for Teros Backend API
 *
 * Tests edge cases, malformed inputs, and error handling
 * to ensure the API is robust and secure.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestServer, type TestServerInstance } from './TestServer';

describe('API Robustness Tests', () => {
  let server: TestServerInstance;

  beforeAll(async () => {
    server = await createTestServer({
      mockResponses: [
        { text: 'Mock response for robustness tests' },
        { text: 'Mock response 2' },
        { text: 'Mock response 3' },
        { text: 'Mock response 4' },
        { text: 'Mock response 5' },
      ],
    });
    await server.seedAgents();
  });

  afterAll(async () => {
    await server.close();
  });

  // ===========================================================================
  // MALFORMED JSON TESTS
  // ===========================================================================

  describe('Malformed JSON', () => {
    it('should handle completely invalid JSON', async () => {
      const client = await server.createClient();

      try {
        // Send raw invalid JSON
        client.getRawSocket().send('this is not json');

        // Server should send error response
        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should handle truncated JSON', async () => {
      const client = await server.createClient();

      try {
        client.getRawSocket().send('{"type": "auth", "method":');

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should handle empty message', async () => {
      const client = await server.createClient();

      try {
        client.getRawSocket().send('');

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should handle JSON with wrong root type (array instead of object)', async () => {
      const client = await server.createClient();

      try {
        client.getRawSocket().send('[1, 2, 3]');

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });
  });

  // ===========================================================================
  // MISSING FIELDS TESTS
  // ===========================================================================

  describe('Missing Required Fields', () => {
    it('should reject auth without method', async () => {
      const client = await server.createClient();

      try {
        client.send({ type: 'auth' });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should reject auth credentials without email', async () => {
      const client = await server.createClient();

      try {
        client.send({ type: 'auth', method: 'credentials', password: 'test' });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should reject auth credentials without password', async () => {
      const client = await server.createClient();

      try {
        client.send({ type: 'auth', method: 'credentials', email: 'test@test.com' });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should reject send_message without channelId', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({
          type: 'send_message',
          content: { type: 'text', text: 'Hello' },
        });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should reject send_message without content', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({
          type: 'send_message',
          channelId: 'ch_test123',
        });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should reject create_channel without agentId', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({ type: 'create_channel' });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });
  });

  // ===========================================================================
  // INVALID TYPE VALUES
  // ===========================================================================

  describe('Invalid Type Values', () => {
    it('should reject unknown message type', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({ type: 'unknown_action_xyz' });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should reject message without type', async () => {
      const client = await server.createClient();

      try {
        client.send({ foo: 'bar' });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should reject type as non-string', async () => {
      const client = await server.createClient();

      try {
        client.send({ type: 123 });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should reject channelId as number', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({
          type: 'get_channel',
          channelId: 12345,
        });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });
  });

  // ===========================================================================
  // INJECTION ATTACKS
  // ===========================================================================

  describe('Injection Attacks', () => {
    it('should handle SQL injection in channelId', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({
          type: 'get_channel',
          channelId: "'; DROP TABLE channels; --",
        });

        const response = await client.waitFor('error', 3000);
        expect(response.code).toBe('CHANNEL_NOT_FOUND');
      } finally {
        client.close();
      }
    });

    it('should handle NoSQL injection in channelId', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        // This should fail Zod validation since channelId must be string
        client.send({
          type: 'get_channel',
          channelId: { $gt: '' },
        });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should handle prototype pollution attempt', async () => {
      const client = await server.createClient();

      try {
        client.getRawSocket().send(
          JSON.stringify({
            type: 'auth',
            method: 'credentials',
            email: 'test@test.com',
            password: 'test',
            __proto__: { isAdmin: true },
            constructor: { prototype: { isAdmin: true } },
          }),
        );

        // Should either error or authenticate normally without pollution
        const response = await client.waitFor(
          (msg) => msg.type === 'auth_success' || msg.type === 'auth_error' || msg.type === 'error',
          3000,
        );

        expect(['auth_success', 'auth_error', 'error']).toContain(response.type);
      } finally {
        client.close();
      }
    });

    it('should handle XSS in message content', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        // Create channel
        client.send({ type: 'create_channel', agentId: 'agent:test' });
        const { channelId } = await client.waitFor('channel_created');

        // Send XSS payload
        client.send({
          type: 'send_message',
          channelId,
          content: {
            type: 'text',
            text: '<script>alert("xss")</script>',
          },
        });

        const response = await client.waitFor('message_sent');
        expect(response.messageId).toBeTruthy();
        // Content should be stored as-is (sanitization is frontend responsibility)
      } finally {
        client.close();
      }
    });
  });

  // ===========================================================================
  // BOUNDARY VALUES
  // ===========================================================================

  describe('Boundary Values', () => {
    it('should handle very long message content', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({ type: 'create_channel', agentId: 'agent:test' });
        const { channelId } = await client.waitFor('channel_created');

        // 100KB message
        const longText = 'x'.repeat(100 * 1024);

        client.send({
          type: 'send_message',
          channelId,
          content: { type: 'text', text: longText },
        });

        const response = await client.waitFor(
          (msg) => msg.type === 'message_sent' || msg.type === 'error',
          5000,
        );

        // Should either accept or reject with proper error
        expect(['message_sent', 'error']).toContain(response.type);
      } finally {
        client.close();
      }
    });

    it('should handle empty string channelId', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({ type: 'get_channel', channelId: '' });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
      } finally {
        client.close();
      }
    });

    it('should handle null channelId', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({ type: 'get_channel', channelId: null });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should handle negative limit in get_messages', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({ type: 'create_channel', agentId: 'agent:test' });
        const { channelId } = await client.waitFor('channel_created');

        client.send({ type: 'get_messages', channelId, limit: -1 });

        // Zod should reject negative limit (positive() validation)
        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });

    it('should handle very large limit in get_messages', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({ type: 'create_channel', agentId: 'agent:test' });
        const { channelId } = await client.waitFor('channel_created');

        // Zod schema has max(100) validation
        client.send({ type: 'get_messages', channelId, limit: 999999999 });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
        expect(response.code).toBe('INVALID_MESSAGE');
      } finally {
        client.close();
      }
    });
  });

  // ===========================================================================
  // AUTHORIZATION TESTS
  // ===========================================================================

  describe('Authorization', () => {
    it('should reject list_channels before authentication', async () => {
      const client = await server.createClient();

      try {
        client.send({ type: 'list_channels' });

        const response = await client.waitFor('error', 3000);
        expect(response.code).toBe('UNAUTHORIZED');
      } finally {
        client.close();
      }
    });

    it('should reject list_agents before authentication', async () => {
      const client = await server.createClient();

      try {
        client.send({ type: 'list_agents' });

        const response = await client.waitFor('error', 3000);
        expect(response.code).toBe('UNAUTHORIZED');
      } finally {
        client.close();
      }
    });

    it('should reject create_channel before authentication', async () => {
      const client = await server.createClient();

      try {
        client.send({ type: 'create_channel', agentId: 'agent:test' });

        const response = await client.waitFor('error', 3000);
        expect(response.code).toBe('UNAUTHORIZED');
      } finally {
        client.close();
      }
    });

    it('should reject send_message before authentication', async () => {
      const client = await server.createClient();

      try {
        client.send({
          type: 'send_message',
          channelId: 'ch_test',
          content: { type: 'text', text: 'hello' },
        });

        const response = await client.waitFor('error', 3000);
        expect(response.code).toBe('UNAUTHORIZED');
      } finally {
        client.close();
      }
    });
  });

  // ===========================================================================
  // CONCURRENCY TESTS
  // ===========================================================================

  describe('Concurrency', () => {
    it('should handle rapid sequential messages', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({ type: 'create_channel', agentId: 'agent:test' });
        const { channelId } = await client.waitFor('channel_created');

        // Send 5 messages rapidly
        for (let i = 0; i < 5; i++) {
          client.send({
            type: 'send_message',
            channelId,
            content: { type: 'text', text: `Message ${i}` },
          });
        }

        // Should receive all acknowledgments
        const acks: any[] = [];
        for (let i = 0; i < 5; i++) {
          const ack = await client.waitFor('message_sent', 5000);
          acks.push(ack);
        }

        expect(acks.length).toBe(5);
        expect(acks.every((a) => a.messageId)).toBe(true);
      } finally {
        client.close();
      }
    });
  });

  // ===========================================================================
  // ERROR RECOVERY TESTS
  // ===========================================================================

  describe('Error Recovery', () => {
    it('should continue working after handling invalid message', async () => {
      const client = await server.createClient();

      try {
        // Send invalid message
        client.getRawSocket().send('invalid json');

        // Wait for error
        const error = await client.waitFor('error', 3000);
        expect(error.type).toBe('error');

        // Should still be able to authenticate
        await client.authenticate();

        // And perform normal operations
        client.send({ type: 'list_agents' });
        const response = await client.waitFor('agents_list', 3000);

        expect(response.agents).toBeArray();
      } finally {
        client.close();
      }
    });

    it('should handle operations on non-existent channel gracefully', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({ type: 'get_channel', channelId: 'ch_nonexistent_12345' });

        const response = await client.waitFor('error', 3000);
        expect(response.code).toBe('CHANNEL_NOT_FOUND');

        // Should still work after error
        client.send({ type: 'list_agents' });
        const agents = await client.waitFor('agents_list', 3000);
        expect(agents.agents).toBeArray();
      } finally {
        client.close();
      }
    });

    it('should handle operations on closed channel', async () => {
      const client = await server.createClient();

      try {
        await client.authenticate();

        // Create and close channel
        client.send({ type: 'create_channel', agentId: 'agent:test' });
        const { channelId } = await client.waitFor('channel_created');

        client.send({ type: 'close_channel', channelId });
        await client.waitFor('channel_closed');

        // Try to send message to closed channel
        client.send({
          type: 'send_message',
          channelId,
          content: { type: 'text', text: 'Hello' },
        });

        const response = await client.waitFor('error', 3000);
        expect(response.type).toBe('error');
      } finally {
        client.close();
      }
    });
  });
});
