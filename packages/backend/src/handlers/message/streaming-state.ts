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
import type { EventHandler } from '../event-handler';

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

type ToolStatus = 'running' | 'pending_permission' | 'pending_user_input';

export interface UpdateToolStatusOptions {
  toolCallId?: string;
  /** Bypass channel for callers that already resolved the binding via `McaToolExecutor.getToolCallContext`. */
  messageId?: string;
  /** Bypass companion to `messageId`: display name from the executor's stable map. */
  toolName?: string;
  permissionRequestId?: string;
  appId?: string;
  irreversible?: boolean;
  /** Inline user form (request-user-input) — set with status 'pending_user_input'. */
  formRequestId?: string;
}

export interface ToolCallInput {
  toolCallId: string;
  toolName: string;
  mcaId?: string;
  input?: Record<string, any>;
}

export interface StreamingState {
  currentTextMessageId: string | null;
  currentTextContent: string;
  /** Map of active tool calls keyed by toolCallId */
  activeToolCalls: Map<string, TrackedToolCall>;
  savedMessages: Array<{ messageId: string; type: string }>;
  lastContentType: 'text' | 'tool' | null;
  /** Pre-reserved id for the first bubble of the turn; shared with `PromptInput.assistantTurnId`. */
  pendingSeedId: string | null;
}

export interface StreamingStateDeps {
  channelManager: ChannelManager;
  channelId: string;
  agentId: string;
  broadcastToChannel: (channelId: string, message: any) => void;
  /** Sender info for assistant messages */
  agentSender?: { type: 'agent'; id: string; name: string };
  /** EventHandler for emitting observer events (channel_permission, etc.) */
  eventHandler?: EventHandler;
  /** Mirror toolCallId → messageId in McaToolExecutor's stable store to survive concurrent closure rebinds. */
  trackToolCall?: (toolCallId: string, messageId: string, toolName: string) => void;
  untrackToolCall?: (toolCallId: string) => void;
}

/**
 * TER-321 invariant: each call to `processAgentResponse` MUST create its
 * own state instance — sharing would re-introduce the cross-session race
 * that TER-321/267 fixed.
 */
export function createStreamingState(assistantTurnSeedId?: string): StreamingState {
  return {
    currentTextMessageId: null,
    currentTextContent: '',
    activeToolCalls: new Map(),
    savedMessages: [],
    lastContentType: null,
    pendingSeedId: assistantTurnSeedId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Layered helpers — TER-351
// ---------------------------------------------------------------------------
// `updateToolStatus` mixes 4 concerns: state lookup (Map), DB persist, WS
// broadcast, and optional observer event. Each is a separate, testable layer.
// `updateToolStatus` is the orchestrator that composes them in the right order.

/** Shape returned by `buildToolStatusContent`. Used as both the DB write payload
 * and the basis of the broadcast event. */
export interface ToolStatusContent {
  type: 'tool_execution';
  toolCallId: string;
  toolName: string;
  mcaId?: string;
  input?: Record<string, any>;
  status: 'pending' | 'pending_permission' | 'pending_user_input' | 'running' | 'completed' | 'failed';
  permissionRequestId?: string;
  appId?: string;
  permissionRequestedAt?: string;
  irreversible?: boolean;
  formRequestId?: string;
  formRequestedAt?: string;
}

interface ToolStatusOptions {
  toolCallId?: string;
  permissionRequestId?: string;
  appId?: string;
  irreversible?: boolean;
  formRequestId?: string;
}

/**
 * Pure builder: produces the persisted content + permissionRequestedAt timestamp
 * (only when status = 'pending_permission').
 */
export function buildToolStatusContent(
  tool: { toolCallId: string; toolName: string; mcaId?: string; input?: Record<string, any> },
  status: ToolStatusContent['status'],
  options: ToolStatusOptions | undefined,
  now: Date = new Date(),
): { content: ToolStatusContent; permissionRequestedAt?: string } {
  const content: ToolStatusContent = {
    type: 'tool_execution',
    toolCallId: tool.toolCallId,
    toolName: tool.toolName,
    mcaId: tool.mcaId,
    input: tool.input,
    status,
  };
  let permissionRequestedAt: string | undefined;
  if (status === 'pending_permission' && options) {
    if (options.permissionRequestId) content.permissionRequestId = options.permissionRequestId;
    if (options.appId) content.appId = options.appId;
    if (options.irreversible) content.irreversible = true;
    permissionRequestedAt = now.toISOString();
    content.permissionRequestedAt = permissionRequestedAt;
  }
  if (status === 'pending_user_input' && options?.formRequestId) {
    content.formRequestId = options.formRequestId;
    content.formRequestedAt = now.toISOString();
  }
  return { content, permissionRequestedAt };
}

/**
 * Builds the WS chunk emitted to the channel when a tool's status changes.
 * Pure — no side effects.
 */
export function buildToolStatusChunk(args: {
  channelId: string;
  messageId: string;
  toolCallId: string;
  status: ToolStatusContent['status'];
  permissionRequestId?: string;
  appId?: string;
  permissionRequestedAt?: string;
  irreversible?: boolean;
  formRequestId?: string;
  now?: number;
}): Record<string, any> {
  const includePermFields =
    args.status === 'pending_permission' && !!args.permissionRequestId;
  const includeFormFields =
    args.status === 'pending_user_input' && !!args.formRequestId;
  return {
    type: 'message_chunk',
    channelId: args.channelId,
    messageId: args.messageId,
    chunkType: 'tool_status_update',
    toolCallId: args.toolCallId,
    toolStatus: args.status,
    ...(includePermFields
      ? {
          permissionRequestId: args.permissionRequestId,
          appId: args.appId,
          ...(args.permissionRequestedAt ? { permissionRequestedAt: args.permissionRequestedAt } : {}),
          ...(args.irreversible ? { irreversible: true } : {}),
        }
      : {}),
    ...(includeFormFields ? { formRequestId: args.formRequestId } : {}),
    timestamp: args.now ?? Date.now(),
  };
}

/**
 * DB persist layer. Pure delegation — kept as a function for testability
 * (swap channelManager mock in tests).
 */
export async function persistToolStatus(
  channelManager: ChannelManager,
  messageId: string,
  content: ToolStatusContent,
): Promise<void> {
  await channelManager.updateMessageContent(messageId, content);
}

/**
 * Field-level persist for the desynced-map case: writes only the status
 * transition (+ permission fields), leaving the toolName/mcaId/input that
 * were persisted at tool_call_start untouched. Used when the tool is absent
 * from THIS streamState — a full-content write would clobber those fields
 * with blanks.
 */
export async function persistToolStatusFields(
  channelManager: ChannelManager,
  messageId: string,
  content: ToolStatusContent,
): Promise<void> {
  const fields: Record<string, any> = { status: content.status };
  if (content.permissionRequestId) fields.permissionRequestId = content.permissionRequestId;
  if (content.appId) fields.appId = content.appId;
  if (content.permissionRequestedAt) fields.permissionRequestedAt = content.permissionRequestedAt;
  if (content.irreversible) fields.irreversible = true;
  if (content.formRequestId) fields.formRequestId = content.formRequestId;
  if (content.formRequestedAt) fields.formRequestedAt = content.formRequestedAt;
  await channelManager.updateMessageContentFields(messageId, fields);
}

/**
 * Observer notification layer — emits `channel_permission` event to the parent
 * channel when the executing channel has an `originChannelId` (delegate-task,
 * voice worker, etc.). Errors are logged but never propagate (fire-and-forget).
 */
export async function notifyObserverPermission(args: {
  channelManager: ChannelManager;
  eventHandler: EventHandler;
  channelId: string;
  toolName: string;
  appId?: string;
  permissionRequestId?: string;
}): Promise<void> {
  try {
    const channel = await args.channelManager.getChannel(args.channelId);
    const observerChannelId = channel?.originChannelId;
    if (!observerChannelId) return;
    const observedChannelName = channel?.metadata?.name || args.channelId;
    await args.eventHandler.handleScheduledEvent({
      channelId: observerChannelId,
      message: `${observedChannelName} needs approval for: ${args.toolName}`,
      eventType: 'channel_permission',
      metadata: {
        observedChannelId: args.channelId,
        observedChannelName,
        toolName: args.toolName,
        appId: args.appId,
        permissionRequestId: args.permissionRequestId,
      },
    });
    console.log(`🔔 channel_permission event sent to observer channel ${observerChannelId}`);
  } catch (err) {
    console.error('[StreamingState] Error sending channel_permission event:', err);
  }
}

/**
 * Creates streaming state helpers for completing messages
 */
export function createStreamingHelpers(state: StreamingState, deps: StreamingStateDeps) {
  const {
    channelManager,
    channelId,
    agentId,
    broadcastToChannel,
    agentSender,
    eventHandler,
    trackToolCall,
    untrackToolCall,
  } = deps;

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
            workspaceId: mediaMsg.workspaceId,
          };
          break;
        case 'browser_live_view':
          mediaContent = {
            type: 'browser_live_view',
            sessionId: mediaMsg.sessionId,
            url: mediaMsg.url,
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
      status: ToolStatus,
      options?: UpdateToolStatusOptions,
    ): Promise<void> {
      const toolCallId = options?.toolCallId;
      if (!toolCallId) {
        console.warn('[StreamingState] updateToolStatus called without toolCallId');
        return;
      }

      // The streamState tool map is per-turn and ephemeral: a reload/resume
      // (TER-267 isolation) can leave it empty while the tool is still tracked
      // by the longer-lived McaToolExecutor. `messageId` therefore falls back to
      // the value the caller already resolved via getToolCallContext — the
      // `options.messageId` "bypass channel". Without this, pending_permission
      // updates were silently dropped and the ControlsBar never appeared. TER-369.
      const trackedTool = state.activeToolCalls.get(toolCallId);
      const messageId = trackedTool?.messageId ?? options?.messageId;
      if (!messageId) {
        console.warn(
          '[StreamingState] updateToolStatus: no messageId (tool absent from streamState and no options.messageId)',
          { toolCallId, status },
        );
        return;
      }
      const target = {
        messageId,
        tool: {
          toolCallId,
          toolName: trackedTool?.toolName ?? options?.toolName ?? '',
          mcaId: trackedTool?.mcaId,
          input: trackedTool?.input,
        },
      };

      const { content, permissionRequestedAt } = buildToolStatusContent(
        target.tool,
        status,
        options,
      );

      if (trackedTool) {
        await persistToolStatus(channelManager, target.messageId, content);
      } else {
        // Desynced map: the long-lived ChannelWorker replays turns ≥2 through
        // the first turn's turnDriver, so the tool was registered in ANOTHER
        // turn's streamState (same frozen-dep disease as TER-386). A full
        // write here would clobber the record created at tool_call_start, but
        // skipping the persist (the old behavior) left the DB on 'pending'
        // forever: the permission widget never survived a reload and restart
        // restore couldn't find the request. Write just the status fields.
        await persistToolStatusFields(channelManager, target.messageId, content);
      }

      broadcastToChannel(
        channelId,
        buildToolStatusChunk({
          channelId,
          messageId: target.messageId,
          toolCallId: target.tool.toolCallId,
          status,
          permissionRequestId: options?.permissionRequestId,
          appId: options?.appId,
          permissionRequestedAt,
          irreversible: options?.irreversible,
          formRequestId: options?.formRequestId,
        }),
      );
      console.log(
        `🔧 Updated tool ${target.tool.toolName || toolCallId} (${toolCallId}) status to: ${status}`,
      );

      if (status === 'pending_permission' && eventHandler) {
        await notifyObserverPermission({
          channelManager,
          eventHandler,
          channelId,
          toolName: target.tool.toolName,
          appId: options?.appId,
          permissionRequestId: options?.permissionRequestId,
        });

      }
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
      attachments?: Array<{ url: string; mime: string; filename?: string }>;
    }): Promise<void> {
      const toolCallId = toolData.toolCallId;
      if (!toolCallId) {
        console.warn('[StreamingState] completeToolMessage called without toolCallId');
        return;
      }
      const trackedTool = state.activeToolCalls.get(toolCallId);
      if (!trackedTool) {
        // tool_result for a turn we never owned — silent drop.
        return;
      }

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
      await channelManager.updateMessageContent(trackedTool.messageId, toolMessage.content);
      broadcastToChannel(channelId, { type: 'message', channelId, message: toolMessage });
      state.savedMessages.push({ messageId: trackedTool.messageId, type: 'tool_execution' });
      console.log(`🔧 Completed tool ${trackedTool.toolName} (${toolCallId}): ${toolData.status}`);
      await handleTerosMessage(toolData.output);

      state.activeToolCalls.delete(toolCallId);
      if (untrackToolCall) untrackToolCall(toolCallId);
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
      if (state.pendingSeedId) {
        state.currentTextMessageId = state.pendingSeedId;
        state.pendingSeedId = null;
      } else {
        state.currentTextMessageId = channelManager.createMessageId();
      }
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
    async startToolMessage(toolCall: ToolCallInput | null): Promise<string> {
      let messageId: string;
      if (state.pendingSeedId) {
        messageId = state.pendingSeedId;
        state.pendingSeedId = null;
      } else {
        messageId = channelManager.createMessageId();
      }
      state.lastContentType = 'tool';

      if (toolCall) {
        state.activeToolCalls.set(toolCall.toolCallId, {
          messageId,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          mcaId: toolCall.mcaId,
          input: toolCall.input,
        });

        if (trackToolCall) {
          trackToolCall(toolCall.toolCallId, messageId, toolCall.toolName);
        }

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
