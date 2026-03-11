/**
 * Streaming State Manager
 *
 * Manages state during LLM streaming responses, tracking text and tool messages.
 * 
 * IMPORTANT: Supports multiple concurrent tool calls using a Map keyed by toolCallId.
 * This is necessary because the LLM can return multiple tool_use blocks in a single response,
 * and we need to track each one independently to update the correct message when it completes.
 */

import type { Message } from '@teros/shared';
import type { ChannelManager } from '../../services/channel-manager';

/**
 * Represents a single tool call being tracked
 */
interface TrackedToolCall {
  messageId: string;
  toolCallId: string;
  toolName: string;
  mcaId?: string;
  input?: Record<string, any>;
}

export interface StreamingState {
  currentTextMessageId: string | null;
  currentTextContent: string;
  /** @deprecated Use activeToolCalls Map instead */
  currentToolMessageId: string | null;
  /** @deprecated Use activeToolCalls Map instead */
  currentToolCall: {
    toolCallId: string;
    toolName: string;
    mcaId?: string;
    input?: Record<string, any>;
  } | null;
  /** Map of active tool calls keyed by toolCallId */
  activeToolCalls: Map<string, TrackedToolCall>;
  savedMessages: Array<{ messageId: string; type: string }>;
  lastContentType: 'text' | 'tool' | null;
}

export interface StreamingStateDeps {
  channelManager: ChannelManager;
  channelId: string;
  agentId: string;
  broadcastToChannel: (channelId: string, message: any) => void;
  /** Sender info for assistant messages */
  agentSender?: { type: 'agent'; id: string; name: string };
}

/**
 * Creates initial streaming state
 */
export function createStreamingState(): StreamingState {
  return {
    currentTextMessageId: null,
    currentTextContent: '',
    currentToolMessageId: null,
    currentToolCall: null,
    activeToolCalls: new Map(),
    savedMessages: [],
    lastContentType: null,
  };
}

/**
 * Creates streaming state helpers for completing messages
 */
export function createStreamingHelpers(state: StreamingState, deps: StreamingStateDeps) {
  const { channelManager, channelId, agentId, broadcastToChannel, agentSender } = deps;

  /**
   * Handle __teros_message__ in tool output (multimedia messages)
   * This allows MCAs to send rich media (images, audio, video, files, html) to the chat
   */
  async function handleTerosMessage(output?: string): Promise<void> {
    if (!output) return;

    try {
      const outputData = JSON.parse(output);
      if (!outputData.__teros_message__) return;

      const mediaMsg = outputData.__teros_message__;
      const mediaMessageId = channelManager.createMessageId();

      // Build the appropriate content based on type
      let mediaContent: any;
      switch (mediaMsg.type) {
        case 'image':
          mediaContent = {
            type: 'image',
            url: mediaMsg.url,
            caption: mediaMsg.caption,
            width: mediaMsg.width,
            height: mediaMsg.height,
            mimeType: mediaMsg.mimeType,
          };
          break;
        case 'audio':
          mediaContent = {
            type: 'audio',
            url: mediaMsg.url,
            caption: mediaMsg.caption,
            duration: mediaMsg.duration,
            mimeType: mediaMsg.mimeType,
          };
          break;
        case 'video':
          mediaContent = {
            type: 'video',
            url: mediaMsg.url,
            caption: mediaMsg.caption,
            duration: mediaMsg.duration,
            width: mediaMsg.width,
            height: mediaMsg.height,
            thumbnailUrl: mediaMsg.thumbnailUrl,
            mimeType: mediaMsg.mimeType,
          };
          break;
        case 'file':
          mediaContent = {
            type: 'file',
            url: mediaMsg.url,
            filename: mediaMsg.filename,
            caption: mediaMsg.caption,
            mimeType: mediaMsg.mimeType,
            size: mediaMsg.size,
          };
          break;
        case 'html':
          mediaContent = {
            type: 'html',
            html: mediaMsg.html,
            caption: mediaMsg.caption,
            height: mediaMsg.height,
          };
          break;
        case 'html_file':
          mediaContent = {
            type: 'html_file',
            filePath: mediaMsg.filePath,
            caption: mediaMsg.caption,
          };
          break;
        default:
          console.warn(`[StreamingState] Unknown __teros_message__ type: ${mediaMsg.type}`);
          return;
      }

      const mediaMessage: Message = {
        messageId: mediaMessageId,
        channelId,
        role: 'assistant',
        agentId,
        sender: agentSender,
        content: mediaContent,
        timestamp: new Date().toISOString(),
      };

      await channelManager.saveMessage(mediaMessage);
      broadcastToChannel(channelId, {
        type: 'message',
        channelId,
        message: mediaMessage,
      });

      state.savedMessages.push({ messageId: mediaMessageId, type: mediaMsg.type });
      console.log(`📎 Saved media message (${mediaMsg.type}): ${mediaMessageId}`);
    } catch (e) {
      // Not JSON or no __teros_message__, ignore silently
    }
  }

  /**
   * Get tracked tool call by toolCallId
   */
  function getToolCall(toolCallId: string): TrackedToolCall | undefined {
    return state.activeToolCalls.get(toolCallId);
  }

  return {
    /**
     * Complete and save current text message
     */
    async completeTextMessage(): Promise<void> {
      if (state.currentTextMessageId && state.currentTextContent.trim()) {
        const textMessage: Message = {
          messageId: state.currentTextMessageId,
          channelId,
          role: 'assistant',
          agentId,
          sender: agentSender,
          content: {
            type: 'text',
            text: state.currentTextContent,
          },
          timestamp: new Date().toISOString(),
        };

        await channelManager.saveMessage(textMessage);
        broadcastToChannel(channelId, {
          type: 'message',
          channelId,
          message: textMessage,
        });

        state.savedMessages.push({ messageId: state.currentTextMessageId, type: 'text' });
        console.log(`📝 Saved text message: ${state.currentTextMessageId}`);
      }
      // Reset text state
      state.currentTextMessageId = null;
      state.currentTextContent = '';
    },

    /**
     * Update tool message status (e.g., from 'pending' to 'running' or 'pending_permission')
     * For 'pending_permission', also stores permissionRequestId and appId for reload recovery
     * 
     * @param toolCallId - The ID of the tool call to update (required for concurrent tool support)
     * @param status - The new status
     * @param options - Additional options for pending_permission status
     */
    async updateToolStatus(
      status: 'running' | 'pending_permission',
      options?: { permissionRequestId?: string; appId?: string; toolCallId?: string },
    ): Promise<void> {
      // Get the tool call - prefer explicit toolCallId, fall back to current (for backwards compat)
      const toolCallId = options?.toolCallId || state.currentToolCall?.toolCallId;
      if (!toolCallId) {
        console.warn('[StreamingState] updateToolStatus called without toolCallId');
        return;
      }

      const trackedTool = state.activeToolCalls.get(toolCallId);
      if (!trackedTool) {
        // Fallback to legacy behavior for backwards compatibility
        const toolCall = state.currentToolCall;
        const messageId = state.currentToolMessageId;

        if (messageId && toolCall && toolCall.toolCallId === toolCallId) {
          const content: Record<string, any> = {
            type: 'tool_execution',
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            mcaId: toolCall.mcaId,
            input: toolCall.input,
            status,
          };

          if (status === 'pending_permission' && options) {
            if (options.permissionRequestId) {
              content.permissionRequestId = options.permissionRequestId;
            }
            if (options.appId) {
              content.appId = options.appId;
            }
          }

          await channelManager.updateMessageContent(messageId, content);
          broadcastToChannel(channelId, {
            type: 'message_chunk',
            channelId,
            messageId,
            chunkType: 'tool_status_update',
            toolCallId: toolCall.toolCallId,
            toolStatus: status,
            timestamp: Date.now(),
          });
          console.log(`🔧 Updated tool status to: ${status} (legacy path)`);
        }
        return;
      }

      const content: Record<string, any> = {
        type: 'tool_execution',
        toolCallId: trackedTool.toolCallId,
        toolName: trackedTool.toolName,
        mcaId: trackedTool.mcaId,
        input: trackedTool.input,
        status,
      };

      // Include permission info for pending_permission status (needed for reload recovery)
      if (status === 'pending_permission' && options) {
        if (options.permissionRequestId) {
          content.permissionRequestId = options.permissionRequestId;
        }
        if (options.appId) {
          content.appId = options.appId;
        }
      }

      await channelManager.updateMessageContent(trackedTool.messageId, content);
      broadcastToChannel(channelId, {
        type: 'message_chunk',
        channelId,
        messageId: trackedTool.messageId,
        chunkType: 'tool_status_update',
        toolCallId: trackedTool.toolCallId,
        toolStatus: status,
        timestamp: Date.now(),
      });
      console.log(`🔧 Updated tool ${trackedTool.toolName} (${toolCallId}) status to: ${status}`);
    },

    /**
     * Complete and update a tool message by toolCallId
     * Updates the existing message with final status and output
     * 
     * @param toolCallId - The ID of the tool call to complete
     * @param toolData - The completion data (status, output, error, duration)
     */
    async completeToolMessage(toolData: {
      toolCallId?: string;
      status: 'completed' | 'failed';
      output?: string;
      error?: string;
      duration?: number;
    }): Promise<void> {
      // Get the tool call - prefer explicit toolCallId, fall back to current (for backwards compat)
      const toolCallId = toolData.toolCallId || state.currentToolCall?.toolCallId;
      if (!toolCallId) {
        console.warn('[StreamingState] completeToolMessage called without toolCallId');
        return;
      }

      const trackedTool = state.activeToolCalls.get(toolCallId);
      if (!trackedTool) {
        // Fallback to legacy behavior for backwards compatibility
        const toolCall = state.currentToolCall;
        const messageId = state.currentToolMessageId;

        if (messageId && toolCall && toolCall.toolCallId === toolCallId) {
          const toolMessage: Message = {
            messageId,
            channelId,
            role: 'assistant',
            agentId,
            sender: agentSender,
            content: {
              type: 'tool_execution',
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              mcaId: toolCall.mcaId,
              input: toolCall.input,
              status: toolData.status,
              output: toolData.output,
              error: toolData.error,
              duration: toolData.duration,
            },
            timestamp: new Date().toISOString(),
          };

          await channelManager.updateMessageContent(messageId, toolMessage.content);
          broadcastToChannel(channelId, {
            type: 'message',
            channelId,
            message: toolMessage,
          });

          state.savedMessages.push({ messageId, type: 'tool_execution' });
          console.log(`🔧 Updated tool message: ${messageId} (legacy path)`);

          await handleTerosMessage(toolData.output);

          // Reset legacy state
          state.currentToolMessageId = null;
          state.currentToolCall = null;
        }
        return;
      }

      // Use the tracked tool call data
      const toolMessage: Message = {
        messageId: trackedTool.messageId,
        channelId,
        role: 'assistant',
        agentId,
        sender: agentSender,
        content: {
          type: 'tool_execution',
          toolCallId: trackedTool.toolCallId,
          toolName: trackedTool.toolName,
          mcaId: trackedTool.mcaId,
          input: trackedTool.input,
          status: toolData.status,
          output: toolData.output,
          error: toolData.error,
          duration: toolData.duration,
        },
        timestamp: new Date().toISOString(),
      };

      // Update existing message (was saved with 'pending' status in startToolMessage)
      await channelManager.updateMessageContent(trackedTool.messageId, toolMessage.content);
      broadcastToChannel(channelId, {
        type: 'message',
        channelId,
        message: toolMessage,
      });

      state.savedMessages.push({ messageId: trackedTool.messageId, type: 'tool_execution' });
      console.log(`🔧 Completed tool ${trackedTool.toolName} (${toolCallId}): ${toolData.status}`);

      // Check for __teros_message__ (multimedia message from agent)
      await handleTerosMessage(toolData.output);

      // Remove from active tool calls
      state.activeToolCalls.delete(toolCallId);

      // Also clear legacy state if it matches
      if (state.currentToolCall?.toolCallId === toolCallId) {
        state.currentToolMessageId = null;
        state.currentToolCall = null;
      }
    },

    /**
     * Expose handleTerosMessage for external use if needed
     */
    handleTerosMessage,

    /**
     * Get a tracked tool call by ID
     */
    getToolCall,

    /**
     * Start a new text message block
     */
    startTextMessage(): string {
      state.currentTextMessageId = channelManager.createMessageId();
      state.currentTextContent = '';
      console.log(`📝 New text message started: ${state.currentTextMessageId}`);
      return state.currentTextMessageId;
    },

    /**
     * Append text to current message
     */
    appendText(text: string): void {
      state.currentTextContent += text;
      state.lastContentType = 'text';
    },

    /**
     * Start a new tool message block
     * Saves immediately to DB with status 'pending' so the widget appears in the UI
     * Status will be updated to 'running' or 'pending_permission' after permission check
     * 
     * Now tracks multiple concurrent tool calls using a Map keyed by toolCallId.
     */
    async startToolMessage(toolCall: StreamingState['currentToolCall']): Promise<string> {
      const messageId = channelManager.createMessageId();
      
      // Legacy state (for backwards compatibility)
      state.currentToolMessageId = messageId;
      state.currentToolCall = toolCall;
      state.lastContentType = 'tool';

      // Track in the Map for concurrent tool support
      if (toolCall) {
        state.activeToolCalls.set(toolCall.toolCallId, {
          messageId,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          mcaId: toolCall.mcaId,
          input: toolCall.input,
        });

        console.log(`🔧 New tool message started: ${messageId} for ${toolCall.toolName} (${toolCall.toolCallId})`);
        console.log(`🔧 Active tool calls: ${state.activeToolCalls.size}`);

        // Save immediately with 'pending' status so widget appears in UI
        const toolMessage: Message = {
          messageId,
          channelId,
          role: 'assistant',
          agentId,
          sender: agentSender,
          content: {
            type: 'tool_execution',
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            mcaId: toolCall.mcaId,
            input: toolCall.input,
            status: 'pending',
          },
          timestamp: new Date().toISOString(),
        };

        await channelManager.saveMessage(toolMessage);
        broadcastToChannel(channelId, {
          type: 'message',
          channelId,
          message: toolMessage,
        });
        console.log(`🔧 Saved tool message (pending): ${messageId}`);
      }

      return messageId;
    },
  };
}

export type StreamingHelpers = ReturnType<typeof createStreamingHelpers>;
