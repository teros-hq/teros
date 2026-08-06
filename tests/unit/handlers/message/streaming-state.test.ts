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
      // Tool tracking is a Map keyed by toolCallId (was currentToolMessageId/currentToolCall).
      expect(state.activeToolCalls).toBeInstanceOf(Map);
      expect(state.activeToolCalls.size).toBe(0);
      expect(state.pendingSeedId).toBeNull();
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
    let updateMessageContentMock: ReturnType<typeof mock>;

    const channelId = 'ch_test123';
    const agentId = 'agent_test456';

    beforeEach(() => {
      state = createStreamingState();
      broadcastMock = mock(() => {});
      saveMessageMock = mock(() => Promise.resolve());
      createMessageIdMock = mock(() => `msg_${Date.now()}`);
      updateMessageContentMock = mock(() => Promise.resolve());

      channelManagerMock = {
        saveMessage: saveMessageMock,
        createMessageId: createMessageIdMock,
        // updateMessageContent: added in signature drift — used by completeToolMessage
        updateMessageContent: updateMessageContentMock,
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
      it('should create new tool message with call info', async () => {
        const helpers = createHelpers();

        const toolCall = {
          toolCallId: 'call_123',
          toolName: 'test_tool',
          mcaId: 'mca.test',
          input: { key: 'value' },
        };

        // startToolMessage is now async — await it to get the messageId string
        const messageId = await helpers.startToolMessage(toolCall);

        expect(messageId).toBeDefined();
        const tracked = state.activeToolCalls.get('call_123');
        expect(tracked?.messageId).toBe(messageId);
        expect(tracked?.toolCallId).toBe('call_123');
        expect(tracked?.toolName).toBe('test_tool');
        expect(tracked?.mcaId).toBe('mca.test');
        expect(tracked?.input).toEqual({ key: 'value' });
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

        // startToolMessage is now async — saves a 'pending' message via saveMessage
        await helpers.startToolMessage({
          toolCallId: 'call_123',
          toolName: 'test_tool',
          input: {},
        });

        await helpers.completeToolMessage({
          toolCallId: 'call_123',
          status: 'completed',
          output: 'Tool output',
          duration: 100,
        });

        // completeToolMessage updates the existing message via updateMessageContent, not saveMessage
        expect(updateMessageContentMock).toHaveBeenCalledTimes(1);
        const updatedContent = updateMessageContentMock.mock.calls[0][1];
        expect(updatedContent.type).toBe('tool_execution');
        expect(updatedContent.status).toBe('completed');
        expect(updatedContent.output).toBe('Tool output');
      });

      it('should reset tool state after completion', async () => {
        const helpers = createHelpers();

        // startToolMessage is now async
        await helpers.startToolMessage({
          toolCallId: 'call_123',
          toolName: 'test_tool',
          input: {},
        });

        await helpers.completeToolMessage({
          toolCallId: 'call_123',
          status: 'completed',
        });

        // Map-based tracking: the completed tool is removed from activeToolCalls.
        expect(state.activeToolCalls.has('call_123')).toBe(false);
        expect(state.activeToolCalls.size).toBe(0);
      });

      it('should handle failed status', async () => {
        const helpers = createHelpers();

        // startToolMessage is now async
        await helpers.startToolMessage({
          toolCallId: 'call_123',
          toolName: 'test_tool',
          input: {},
        });

        await helpers.completeToolMessage({
          toolCallId: 'call_123',
          status: 'failed',
          error: 'Something went wrong',
        });

        // completeToolMessage updates via updateMessageContent, not saveMessage
        const updatedContent = updateMessageContentMock.mock.calls[0][1];
        expect(updatedContent.status).toBe('failed');
        expect(updatedContent.error).toBe('Something went wrong');
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

    // bug tracker
    // @todo alice - 2026-04-02: fix bug — audit all call sites of startToolMessage and add await; update type signatures to reflect the async return
    it.todo('bug: startToolMessage changed from sync to async without updating call sites — any caller that does not await it will get a Promise instead of the messageId string');
  });
});
