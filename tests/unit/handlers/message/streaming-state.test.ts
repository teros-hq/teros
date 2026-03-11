/**
 * Tests for StreamingState
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  createStreamingHelpers,
  createStreamingState,
} from '../../../../packages/backend/src/handlers/message/streaming-state';

describe('StreamingState', () => {
  describe('createStreamingState', () => {
    it('should create initial state with null values', () => {
      const state = createStreamingState();

      expect(state.currentTextMessageId).toBeNull();
      expect(state.currentTextContent).toBe('');
      expect(state.currentToolMessageId).toBeNull();
      expect(state.currentToolCall).toBeNull();
      expect(state.savedMessages).toEqual([]);
      expect(state.lastContentType).toBeNull();
    });
  });

  describe('createStreamingHelpers', () => {
    let state: ReturnType<typeof createStreamingState>;
    let broadcastMock: ReturnType<typeof mock>;
    let saveMessageMock: ReturnType<typeof mock>;
    let createMessageIdMock: ReturnType<typeof mock>;
    let channelManagerMock: any;

    const channelId = 'ch_test123';
    const agentId = 'agent_test456';

    beforeEach(() => {
      state = createStreamingState();
      broadcastMock = mock(() => {});
      saveMessageMock = mock(() => Promise.resolve());
      createMessageIdMock = mock(() => `msg_${Date.now()}`);

      channelManagerMock = {
        saveMessage: saveMessageMock,
        createMessageId: createMessageIdMock,
      };
    });

    const createHelpers = () =>
      createStreamingHelpers(state, {
        channelManager: channelManagerMock,
        channelId,
        agentId,
        broadcastToChannel: broadcastMock,
      });

    describe('startTextMessage', () => {
      it('should create new message ID and reset content', () => {
        const helpers = createHelpers();

        const messageId = helpers.startTextMessage();

        expect(messageId).toBeDefined();
        expect(state.currentTextMessageId).toBe(messageId);
        expect(state.currentTextContent).toBe('');
      });
    });

    describe('appendText', () => {
      it('should append text to current content', () => {
        const helpers = createHelpers();

        helpers.appendText('Hello ');
        helpers.appendText('World');

        expect(state.currentTextContent).toBe('Hello World');
        expect(state.lastContentType).toBe('text');
      });
    });

    describe('startToolMessage', () => {
      it('should create new tool message with call info', () => {
        const helpers = createHelpers();

        const toolCall = {
          toolCallId: 'call_123',
          toolName: 'test_tool',
          mcpId: 'mca.test',
          input: { key: 'value' },
        };

        const messageId = helpers.startToolMessage(toolCall);

        expect(messageId).toBeDefined();
        expect(state.currentToolMessageId).toBe(messageId);
        expect(state.currentToolCall).toEqual(toolCall);
        expect(state.lastContentType).toBe('tool');
      });
    });

    describe('completeTextMessage', () => {
      it('should save message when there is content', async () => {
        const helpers = createHelpers();

        helpers.startTextMessage();
        helpers.appendText('Test message');

        await helpers.completeTextMessage();

        expect(saveMessageMock).toHaveBeenCalledTimes(1);
        expect(broadcastMock).toHaveBeenCalledTimes(1);
        expect(state.savedMessages.length).toBe(1);
        expect(state.savedMessages[0].type).toBe('text');
      });

      it('should not save message when content is empty', async () => {
        const helpers = createHelpers();

        helpers.startTextMessage();
        // No text appended

        await helpers.completeTextMessage();

        expect(saveMessageMock).not.toHaveBeenCalled();
        expect(state.savedMessages.length).toBe(0);
      });

      it('should reset text state after completion', async () => {
        const helpers = createHelpers();

        helpers.startTextMessage();
        helpers.appendText('Test');

        await helpers.completeTextMessage();

        expect(state.currentTextMessageId).toBeNull();
        expect(state.currentTextContent).toBe('');
      });
    });

    describe('completeToolMessage', () => {
      it('should save tool message with result', async () => {
        const helpers = createHelpers();

        helpers.startToolMessage({
          toolCallId: 'call_123',
          toolName: 'test_tool',
          input: {},
        });

        await helpers.completeToolMessage({
          status: 'completed',
          output: 'Tool output',
          duration: 100,
        });

        expect(saveMessageMock).toHaveBeenCalledTimes(1);
        const savedMessage = saveMessageMock.mock.calls[0][0];
        expect(savedMessage.content.type).toBe('tool_execution');
        expect(savedMessage.content.status).toBe('completed');
        expect(savedMessage.content.output).toBe('Tool output');
      });

      it('should reset tool state after completion', async () => {
        const helpers = createHelpers();

        helpers.startToolMessage({
          toolCallId: 'call_123',
          toolName: 'test_tool',
          input: {},
        });

        await helpers.completeToolMessage({
          status: 'completed',
        });

        expect(state.currentToolMessageId).toBeNull();
        expect(state.currentToolCall).toBeNull();
      });

      it('should handle failed status', async () => {
        const helpers = createHelpers();

        helpers.startToolMessage({
          toolCallId: 'call_123',
          toolName: 'test_tool',
          input: {},
        });

        await helpers.completeToolMessage({
          status: 'failed',
          error: 'Something went wrong',
        });

        const savedMessage = saveMessageMock.mock.calls[0][0];
        expect(savedMessage.content.status).toBe('failed');
        expect(savedMessage.content.error).toBe('Something went wrong');
      });
    });

    describe('handleTerosMessage', () => {
      it('should create media message for image type', async () => {
        const helpers = createHelpers();

        const output = JSON.stringify({
          __teros_message__: {
            type: 'image',
            url: 'https://example.com/image.png',
            caption: 'Test image',
          },
        });

        await helpers.handleTerosMessage(output);

        expect(saveMessageMock).toHaveBeenCalledTimes(1);
        const savedMessage = saveMessageMock.mock.calls[0][0];
        expect(savedMessage.content.type).toBe('image');
        expect(savedMessage.content.url).toBe('https://example.com/image.png');
      });

      it('should ignore non-JSON output', async () => {
        const helpers = createHelpers();

        await helpers.handleTerosMessage('plain text output');

        expect(saveMessageMock).not.toHaveBeenCalled();
      });

      it('should ignore JSON without __teros_message__', async () => {
        const helpers = createHelpers();

        await helpers.handleTerosMessage(JSON.stringify({ other: 'data' }));

        expect(saveMessageMock).not.toHaveBeenCalled();
      });
    });
  });
});
