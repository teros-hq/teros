/**
 * Smoke Tests — Minimal integration tests using the WsFramework protocol.
 *
 * These tests validate the new domain-based API (type: "request", action: "domain.verb").
 * They are intentionally minimal: one passing test per feature area is enough to
 * prove the infrastructure works. Deeper coverage belongs in api.test.ts once
 * that file is updated to use the new protocol.
 *
 * @see packages/shared/src/ws-framework.ts — WsRequest format
 * @see packages/backend/src/handlers/domains/ — registered handlers
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestServer, type TestServerInstance } from '@teros/testing';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a WsFramework request message */
function req(action: string, data: Record<string, unknown> = {}, requestId = 'req_1') {
  return { type: 'request', requestId, action, data };
}

/** Wait for a WsFramework response (type: "response" | "error") for a given requestId */
async function waitForResponse(client: any, requestId = 'req_1') {
  return client.waitFor(
    (msg: any) =>
      (msg.type === 'response' || msg.type === 'error') && msg.requestId === requestId,
    8000,
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Smoke Tests — WsFramework protocol', () => {
  let server: TestServerInstance;

  beforeAll(async () => {
    server = await createTestServer({
      mockResponses: [{ text: 'Hello from mock LLM!' }],
    });
    await server.seedAgents();
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  describe('Auth', () => {
    it('should authenticate with valid credentials and return userId starting with "user:"', async () => {
      const client = await server.createClient();
      try {
        const { userId, sessionToken } = await client.authenticate('test@example.com', 'password');
        expect(userId).toMatch(/^user:/);
        expect(sessionToken).toBeTruthy();
      } finally {
        client.close();
      }
    });

    it('should reject auth with invalid email format', async () => {
      const client = await server.createClient();
      try {
        client.send({ type: 'auth', method: 'credentials', email: 'not-an-email', password: 'x' });
        const response = await client.waitFor('auth_error');
        expect(response.type).toBe('auth_error');
      } finally {
        client.close();
      }
    });

    it('should return UNAUTHORIZED for WsFramework requests without auth', async () => {
      const client = await server.createClient();
      try {
        client.send(req('agent.list'));
        // Unauthenticated → server sends a plain error (not a WsResponse)
        const response = await client.waitFor(
          (msg: any) => msg.type === 'error',
          5000,
        );
        expect(response.type).toBe('error');
        expect(response.code).toBe('UNAUTHORIZED');
      } finally {
        client.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Agent listing
  // -------------------------------------------------------------------------

  describe('agent.list', () => {
    it('should return an agents array for authenticated user', async () => {
      const client = await server.createClient();
      try {
        await client.authenticate('test@example.com', 'password');

        client.send(req('agent.list', {}));
        const response = await waitForResponse(client);

        expect(response.type).toBe('response');
        expect(response.data).toHaveProperty('agents');
        expect(Array.isArray(response.data.agents)).toBe(true);
      } finally {
        client.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Channel creation
  // -------------------------------------------------------------------------

  describe('channel.create', () => {
    it('should create a channel and return a channelId', async () => {
      const client = await server.createClient();
      try {
        const { userId } = await client.authenticate('test@example.com', 'password');

        // channel.create requires workspaceId — use a synthetic one for the test
        client.send(
          req('channel.create', {
            agentId: 'agent:iria',
            workspaceId: 'ws_test',
          }),
        );

        const response = await waitForResponse(client);

        expect(response.type).toBe('response');
        expect(response.data).toHaveProperty('channelId');
        expect(typeof response.data.channelId).toBe('string');
        expect(response.data.channelId.length).toBeGreaterThan(0);
      } finally {
        client.close();
      }
    });

    it('should return error when agentId is missing', async () => {
      const client = await server.createClient();
      try {
        await client.authenticate('test@example.com', 'password');

        client.send(req('channel.create', { workspaceId: 'ws_test' }, 'req_no_agent'));
        const response = await waitForResponse(client, 'req_no_agent');

        expect(response.type).toBe('error');
        expect(response.code).toBeTruthy();
      } finally {
        client.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Channel list
  // -------------------------------------------------------------------------

  describe('channel.list', () => {
    it('should return channels array after creating one', async () => {
      const client = await server.createClient();
      try {
        await client.authenticate('test@example.com', 'password');

        // Create a channel first
        client.send(req('channel.create', { agentId: 'agent:iria', workspaceId: 'ws_test' }, 'req_create'));
        const createResp = await waitForResponse(client, 'req_create');
        expect(createResp.type).toBe('response');

        // List channels — pass workspaceId to match the channel we just created
        client.send(req('channel.list', { workspaceId: 'ws_test' }, 'req_list'));
        const listResp = await waitForResponse(client, 'req_list');

        expect(listResp.type).toBe('response');
        expect(listResp.data).toHaveProperty('channels');
        expect(Array.isArray(listResp.data.channels)).toBe(true);
        expect(listResp.data.channels.length).toBeGreaterThanOrEqual(1);
      } finally {
        client.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // UNKNOWN_ACTION
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('should return UNKNOWN_ACTION for unregistered actions', async () => {
      const client = await server.createClient();
      try {
        await client.authenticate('test@example.com', 'password');

        client.send(req('does.not.exist', {}, 'req_unknown'));
        const response = await waitForResponse(client, 'req_unknown');

        expect(response.type).toBe('error');
        expect(response.code).toBe('UNKNOWN_ACTION');
      } finally {
        client.close();
      }
    });
  });
});
