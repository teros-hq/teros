/**
 * Tool Execution E2E Tests
 *
 * Tests the complete tool execution flow:
 * 1. User sends message requiring tool
 * 2. Agent calls tool via LLM
 * 3. Tool is executed via MCP
 * 4. Tool result is sent back to LLM
 * 5. Agent responds with final answer
 * 6. All events are streamed correctly
 * 7. Messages are persisted in database with tool_execution content
 */

import { describe, expect, it } from 'bun:test';
import { createTestServer } from './TestServer';

describe('Tool Execution Flow', () => {
  describe('Complete Tool Execution Lifecycle', () => {
    it('should execute tool and persist tool_execution content', async () => {
      // Create server with mock responses that include tool calls
      const server = await createTestServer({
        mockResponses: [
          // Mock response with tool call
          {
            text: 'Let me check that for you.',
            toolCalls: [
              {
                id: 'tool_call_001',
                name: 'bash',
                input: { command: 'uptime', description: 'Check system uptime' },
              },
            ],
          },
          // Mock final response after tool execution
          {
            text: 'The system has been running for 5 days, 3 hours, and 42 minutes.',
          },
        ],
      });
      await server.seedAgents();

      const client = await server.createClient();

      try {
        await client.authenticate();

        // Create channel with agent that has tools
        client.send({
          type: 'create_channel',
          agentId: 'agent:iria',
          metadata: { transport: 'websocket' },
        });
        const { channelId } = await client.waitFor('channel_created');

        // Subscribe to channel for real-time events
        client.send({
          type: 'subscribe_channel',
          channelId,
        });

        // Send message requiring tool
        client.send({
          type: 'send_message',
          channelId,
          content: {
            type: 'text',
            text: 'How long has the system been running?',
          },
        });

        // 1. Should receive message_sent acknowledgment
        const ack = await client.waitFor('message_sent');
        expect(ack.messageId).toBeTruthy();
        expect(ack.timestamp).toBeTruthy();

        // 2. Should receive user message broadcast
        const userMsg = await client.waitFor(
          (msg) => msg.type === 'message' && msg.message?.role === 'user',
        );
        expect(userMsg.message.content.text).toBe('How long has the system been running?');

        // 3. Should receive typing indicator (agent is processing)
        const typingStart = await client.waitFor(
          (msg) => msg.type === 'typing' && msg.isTyping === true,
          1000,
        );
        expect(typingStart.channelId).toBe(channelId);
        expect(typingStart.agentId).toBe('agent:iria');

        // 4. Should receive text_chunk first (from tool-using response)
        await client.waitFor(
          (msg) => msg.type === 'message_chunk' && msg.chunkType === 'text_chunk',
          1000,
        );

        // 5. Should receive tool_call_start chunk
        const toolStartChunk = await client.waitFor(
          (msg) => msg.type === 'message_chunk' && msg.chunkType === 'tool_call_start',
          10000,
        );

        expect(toolStartChunk).toBeTruthy();
        expect(toolStartChunk.channelId).toBe(channelId);
        expect(toolStartChunk.toolCallId).toBeTruthy();
        expect(toolStartChunk.toolName).toBeTruthy();
        expect(toolStartChunk.timestamp).toBeNumber();

        const toolCallId = toolStartChunk.toolCallId;
        const toolName = toolStartChunk.toolName;

        // 6. Should receive tool_call_complete chunk
        const toolCompleteChunk = await client.waitFor(
          (msg) =>
            msg.type === 'message_chunk' &&
            msg.chunkType === 'tool_call_complete' &&
            msg.toolCallId === toolCallId,
          10000,
        );

        expect(toolCompleteChunk).toBeTruthy();
        expect(toolCompleteChunk.channelId).toBe(channelId);
        expect(toolCompleteChunk.toolCallId).toBe(toolCallId);
        expect(toolCompleteChunk.timestamp).toBeGreaterThan(toolStartChunk.timestamp);

        // 7. Should receive agent's final text response (after tool execution)
        const agentResponse = await client.waitFor(
          (msg) =>
            msg.type === 'message' &&
            msg.message?.role === 'agent' &&
            msg.message?.content?.type === 'text',
          10000,
        );

        expect(agentResponse.channelId).toBe(channelId);
        expect(agentResponse.message.agentId).toBe('agent:iria');
        expect(agentResponse.message.content.text).toBeTruthy();

        // 8. Should receive typing stop
        const typingStop = await client.waitFor(
          (msg) => msg.type === 'typing' && msg.isTyping === false,
        );
        expect(typingStop.channelId).toBe(channelId);

        // 9. CRITICAL: Verify tool_execution is persisted in database
        client.send({
          type: 'get_messages',
          channelId,
          limit: 50,
        });

        const history = await client.waitFor('messages_history');
        expect(history.channelId).toBe(channelId);
        expect(history.messages).toBeArray();

        // Find the agent message with tool execution
        const agentMessages = history.messages.filter((m: any) => m.role === 'agent');
        expect(agentMessages.length).toBeGreaterThanOrEqual(1);

        // Check if any agent message has tool_execution content
        const messageWithTool = agentMessages.find((m: any) => m.content.type === 'tool_execution');

        expect(messageWithTool).toBeTruthy();
        expect(messageWithTool.content.type).toBe('tool_execution');
        expect(messageWithTool.content.toolCallId).toBe(toolCallId);
        expect(messageWithTool.content.toolName).toBe(toolName);
        expect(messageWithTool.content.status).toMatch(/^(completed|failed)$/);

        if (messageWithTool.content.status === 'completed') {
          expect(messageWithTool.content.output).toBeTruthy();
        } else {
          expect(messageWithTool.content.error).toBeTruthy();
        }

        // Verify duration is present
        expect(messageWithTool.content.duration).toBeNumber();
        expect(messageWithTool.content.duration).toBeGreaterThan(0);
      } finally {
        client.close();
        await server.close();
      }
    });
  });

  describe('Tool Execution Without Tools', () => {
    it('should work gracefully when agent does not request tools', async () => {
      // Use test agent without tool calls in mock response
      const server = await createTestServer({
        mockResponses: [{ text: 'I cannot execute commands as I do not have tool access.' }],
      });

      await server.seedAgents();

      const client = await server.createClient();

      try {
        await client.authenticate();

        client.send({ type: 'create_channel', agentId: 'agent:test' });
        const { channelId } = await client.waitFor('channel_created');

        client.send({ type: 'subscribe_channel', channelId });

        client.send({
          type: 'send_message',
          channelId,
          content: { type: 'text', text: 'Tell me a joke' },
        });

        await client.waitFor('message_sent');

        // Should get agent response without tool chunks
        const agentMsg = await client.waitFor(
          (msg: any) => msg.type === 'message' && msg.message?.role === 'agent',
          10000,
        );

        expect(agentMsg.message.content.text).toBeTruthy();

        // Verify no tool_execution in database
        client.send({ type: 'get_messages', channelId, limit: 50 });
        const history = await client.waitFor('messages_history');

        const toolExecutions = history.messages.filter(
          (m: any) => m.content.type === 'tool_execution',
        );

        expect(toolExecutions.length).toBe(0);
      } finally {
        client.close();
        await server.close();
      }
    });
  });
});
