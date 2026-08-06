/**
 * Integration tests — Feedback WS handlers via TestServer
 *
 * Covers:
 *   - conversation.message.feedback: success + validation errors
 *   - conversation.message.action: copy success, report success, report error
 *   - conversation.feedback: success + validation errors
 *   - Cross-user authz: owner OK, outsider → FORBIDDEN_WORKSPACE
 *
 * Uses TestServer with enableNavbarStack so workspace/channel creation works,
 * plus an injected McaManager mock for the report action.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { McaManager } from '../../src/services/mca-manager';
import {
  createTestServer,
  type TestServerInstance,
  type TestWebSocketClient,
} from '@teros/testing';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const OWNER_EMAIL = 'user1@test.com';
const OUTSIDER_EMAIL = 'user2@test.com';
const WORKSPACE_ID = 'work_feedback_test';
const CHANNEL_ID = 'ch_feedback_test';
const MESSAGE_ID = 'msg_feedback_test';
const AGENT_ID = 'agent:test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Exposed so individual tests can assert the exact payload sent to the tool and
// can force failure modes. Reset in beforeEach.
let executeToolMock: ReturnType<typeof mock>;
let reportBehavior: 'ok' | 'isError' | 'throw' = 'ok';

function createMockMcaManager(): McaManager {
  executeToolMock = mock(async (toolName: string, input: Record<string, any>) => {
    if (toolName === 'feedback_report-bug') {
      if (reportBehavior === 'throw') throw new Error('feedback tool upstream exploded');
      if (reportBehavior === 'isError') return { output: 'tool failed internally', isError: true };
      return {
        output: JSON.stringify({ bugReportId: 'bug_123', title: input.title }),
        isError: false,
      };
    }
    return { output: 'unknown tool', isError: true };
  });
  return { executeTool: executeToolMock } as unknown as McaManager;
}

async function resetTestData(server: TestServerInstance) {
  // Clean up only the documents this test suite touches so each test starts
  // from a known state without paying the cost of a full server restart.
  await server.db.collection('workspaces').deleteMany({ workspaceId: WORKSPACE_ID });
  await server.db.collection('workspace_members').deleteMany({ workspaceId: WORKSPACE_ID });
  await server.db.collection('channels').deleteMany({ channelId: CHANNEL_ID });
  await server.db.collection('channel_messages').deleteMany({ channelId: CHANNEL_ID });
  await server.db.collection('apps').deleteMany({ appId: 'app_feedback' });
  await server.db.collection('message_feedback').deleteMany({ conversationId: CHANNEL_ID });
  await server.db.collection('message_actions').deleteMany({ conversationId: CHANNEL_ID });
  await server.db.collection('conversation_feedback').deleteMany({ conversationId: CHANNEL_ID });
}

async function seedChannel(server: TestServerInstance) {
  await server.db.collection('workspaces').insertOne({
    workspaceId: WORKSPACE_ID,
    ownerId: 'user:test_user1',
    name: 'Feedback Test Workspace',
    status: 'active',
    members: [{ userId: 'user:test_user1', role: 'admin', addedAt: new Date() }],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await server.db.collection('workspace_members').insertOne({
    workspaceId: WORKSPACE_ID,
    userId: 'user:test_user1',
    role: 'admin',
    addedAt: new Date(),
  });

  await server.db.collection('channels').insertOne({
    channelId: CHANNEL_ID,
    workspaceId: WORKSPACE_ID,
    userId: 'user:test_user1',
    agentId: AGENT_ID,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await server.db.collection('channel_messages').insertOne({
    messageId: MESSAGE_ID,
    channelId: CHANNEL_ID,
    role: 'assistant',
    agentId: AGENT_ID,
    content: [{ type: 'text', text: 'Hello from the assistant' }],
    timestamp: new Date(),
  });

  await server.db.collection('apps').insertOne({
    appId: 'app_feedback',
    mcaId: 'mca.teros.feedback',
    ownerId: WORKSPACE_ID,
    ownerType: 'workspace',
    name: 'feedback',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function sendRequest(client: TestWebSocketClient, requestId: string, action: string, data: any) {
  client.send({ type: 'request', requestId, action, data });
}

async function waitForResponse(client: TestWebSocketClient, requestId: string, timeoutMs = 5000) {
  return client.waitFor(
    (msg: any) => (msg.type === 'response' || msg.type === 'error') && msg.requestId === requestId,
    timeoutMs,
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Feedback WS handlers', () => {
  let server: TestServerInstance;
  let ownerClient: TestWebSocketClient;
  let outsiderClient: TestWebSocketClient;

  beforeAll(async () => {
    server = await createTestServer({
      enableNavbarStack: true,
      mcaManager: createMockMcaManager(),
    });
    await server.seedAgents();
  });

  beforeEach(async () => {
    await resetTestData(server);
    await seedChannel(server);

    reportBehavior = 'ok';
    executeToolMock?.mockClear();

    ownerClient = await server.createClient();
    await ownerClient.authenticate(OWNER_EMAIL);

    outsiderClient = await server.createClient();
    await outsiderClient.authenticate(OUTSIDER_EMAIL);
  });

  afterEach(async () => {
    ownerClient?.close();
    outsiderClient?.close();
  });

  afterAll(async () => {
    await server?.close();
  });

  // -------------------------------------------------------------------------
  // conversation.message.feedback
  // -------------------------------------------------------------------------

  describe('conversation.message.feedback', () => {
    it('upserts a thumbs-up rating', async () => {
      const requestId = 'fb-up-1';
      sendRequest(ownerClient, requestId, 'conversation.message.feedback', {
        messageId: MESSAGE_ID,
        channelId: CHANNEL_ID,
        rating: 'up',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.type).toBe('response');
      expect(response.data.rating).toBe('up');
      expect(response.data.messageId).toBe(MESSAGE_ID);
      expect(response.data.feedbackId.startsWith('fb_')).toBe(true);
      expect(response.data.createdAt).toBeDefined();
    });

    it('rejects invalid rating', async () => {
      const requestId = 'fb-invalid';
      sendRequest(ownerClient, requestId, 'conversation.message.feedback', {
        messageId: MESSAGE_ID,
        channelId: CHANNEL_ID,
        rating: 'sideways',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.type).toBe('error');
      expect(response.code).toBe('INVALID_RATING');
    });

    it('rejects feedback on non-assistant messages', async () => {
      const userMessageId = 'msg_user_1';
      await server.db.collection('channel_messages').insertOne({
        messageId: userMessageId,
        channelId: CHANNEL_ID,
        role: 'user',
        content: [{ type: 'text', text: 'User question' }],
        timestamp: new Date(),
      });

      const requestId = 'fb-user-msg';
      sendRequest(ownerClient, requestId, 'conversation.message.feedback', {
        messageId: userMessageId,
        channelId: CHANNEL_ID,
        rating: 'up',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.code).toBe('INVALID_MESSAGE');
    });

    it('rejects feedback on a non-existent message with MESSAGE_NOT_FOUND', async () => {
      const requestId = 'fb-no-msg';
      sendRequest(ownerClient, requestId, 'conversation.message.feedback', {
        messageId: 'msg_does_not_exist',
        channelId: CHANNEL_ID,
        rating: 'up',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.code).toBe('MESSAGE_NOT_FOUND');
    });

    it('denies outsider access with FORBIDDEN_WORKSPACE', async () => {
      const requestId = 'fb-outsider';
      sendRequest(outsiderClient, requestId, 'conversation.message.feedback', {
        messageId: MESSAGE_ID,
        channelId: CHANNEL_ID,
        rating: 'up',
      });

      const response = await waitForResponse(outsiderClient, requestId);
      expect(response.code).toBe('FORBIDDEN_WORKSPACE');
    });
  });

  // -------------------------------------------------------------------------
  // conversation.message.action
  // -------------------------------------------------------------------------

  describe('conversation.message.action', () => {
    it('logs a copy action', async () => {
      const requestId = 'act-copy-1';
      sendRequest(ownerClient, requestId, 'conversation.message.action', {
        messageId: MESSAGE_ID,
        channelId: CHANNEL_ID,
        action: 'copy',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.type).toBe('response');
      expect(response.data.action).toBe('copy');
      expect(response.data.actionId.startsWith('act_')).toBe(true);
      expect(response.data.createdAt).toBeDefined();
    });

    it('submits a report and returns bugReportId', async () => {
      const requestId = 'act-report-1';
      sendRequest(ownerClient, requestId, 'conversation.message.action', {
        messageId: MESSAGE_ID,
        channelId: CHANNEL_ID,
        action: 'report',
        description: 'The assistant gave wrong info',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.type).toBe('response');
      expect(response.data.action).toBe('report');
      expect(response.data.bugReportId).toBe('bug_123');
      expect(response.data.actionId.startsWith('act_')).toBe(true);

      // The feedback tool must be invoked exactly once with the fully-composed
      // payload — not just "called". A bad title/severity/description would
      // otherwise pass silently behind the bugReportId assertion.
      expect(executeToolMock).toHaveBeenCalledTimes(1);
      const [toolName, input, context] = executeToolMock.mock.calls[0];
      expect(toolName).toBe('feedback_report-bug');
      expect(input.title).toBe(`Message report: ${MESSAGE_ID}`);
      expect(input.severity).toBe('medium');
      expect(input.description).toContain('The assistant gave wrong info'); // user's text
      expect(input.description).toContain(MESSAGE_ID); // reported-message link
      expect(input.description).toContain(CHANNEL_ID); // conversation link
      expect(context.appId).toBe('app_feedback');
      expect(context.workspaceId).toBe(WORKSPACE_ID);
      expect(context.channelId).toBe(CHANNEL_ID);
    });

    it('rejects report without description', async () => {
      const requestId = 'act-report-no-desc';
      sendRequest(ownerClient, requestId, 'conversation.message.action', {
        messageId: MESSAGE_ID,
        channelId: CHANNEL_ID,
        action: 'report',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.code).toBe('MISSING_FIELDS');
    });

    it('rejects invalid action', async () => {
      const requestId = 'act-invalid';
      sendRequest(ownerClient, requestId, 'conversation.message.action', {
        messageId: MESSAGE_ID,
        channelId: CHANNEL_ID,
        action: 'delete',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.code).toBe('INVALID_ACTION');
    });

    it('rejects an action on a non-existent channel with CHANNEL_NOT_FOUND', async () => {
      const requestId = 'act-no-channel';
      sendRequest(ownerClient, requestId, 'conversation.message.action', {
        messageId: MESSAGE_ID,
        channelId: 'ch_does_not_exist',
        action: 'copy',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.code).toBe('CHANNEL_NOT_FOUND');
    });

    it('rejects a report when the feedback app is not installed (FEEDBACK_APP_NOT_FOUND)', async () => {
      await server.db.collection('apps').deleteMany({ appId: 'app_feedback' });

      const requestId = 'act-no-app';
      sendRequest(ownerClient, requestId, 'conversation.message.action', {
        messageId: MESSAGE_ID,
        channelId: CHANNEL_ID,
        action: 'report',
        description: 'Something is broken',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.code).toBe('FEEDBACK_APP_NOT_FOUND');
    });

    it('maps a tool isError result to REPORT_FAILED', async () => {
      reportBehavior = 'isError';

      const requestId = 'act-report-iserr';
      sendRequest(ownerClient, requestId, 'conversation.message.action', {
        messageId: MESSAGE_ID,
        channelId: CHANNEL_ID,
        action: 'report',
        description: 'Something is broken',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.code).toBe('REPORT_FAILED');
    });

    it('maps a thrown tool error to REPORT_FAILED', async () => {
      reportBehavior = 'throw';

      const requestId = 'act-report-throw';
      sendRequest(ownerClient, requestId, 'conversation.message.action', {
        messageId: MESSAGE_ID,
        channelId: CHANNEL_ID,
        action: 'report',
        description: 'Something is broken',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.code).toBe('REPORT_FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // conversation.feedback
  // -------------------------------------------------------------------------

  describe('conversation.feedback', () => {
    it('creates conversation-level feedback', async () => {
      const requestId = 'conv-fb-1';
      sendRequest(ownerClient, requestId, 'conversation.feedback', {
        channelId: CHANNEL_ID,
        rating: 5,
        solvedProblem: true,
        comment: 'Resolved everything',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.type).toBe('response');
      expect(response.data.rating).toBe(5);
      expect(response.data.conversationId).toBe(CHANNEL_ID);
      expect(response.data.conversationFeedbackId.startsWith('cfb_')).toBe(true);
    });

    it('accepts up/down rating strings', async () => {
      const requestId = 'conv-fb-up';
      sendRequest(ownerClient, requestId, 'conversation.feedback', {
        channelId: CHANNEL_ID,
        rating: 'up',
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.type).toBe('response');
      expect(response.data.rating).toBe('up');
    });

    it('rejects missing rating', async () => {
      const requestId = 'conv-fb-no-rating';
      sendRequest(ownerClient, requestId, 'conversation.feedback', {
        channelId: CHANNEL_ID,
      });

      const response = await waitForResponse(ownerClient, requestId);
      expect(response.code).toBe('MISSING_FIELDS');
    });

    it('denies outsider access with FORBIDDEN_WORKSPACE', async () => {
      const requestId = 'conv-fb-outsider';
      sendRequest(outsiderClient, requestId, 'conversation.feedback', {
        channelId: CHANNEL_ID,
        rating: 'down',
      });

      const response = await waitForResponse(outsiderClient, requestId);
      expect(response.code).toBe('FORBIDDEN_WORKSPACE');
    });
  });
});
