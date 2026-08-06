/**
 * Message Processor - Cloned from the previous implementation
 *
 * Handles streaming LLM responses and updates parts in real-time.
 * Replicates the previous implementation's processor object from prompt.ts.
 *
 *
 */

import type { LLMResponse, ToolCall, ToolResult } from '../llm/ILLMClient';
import { createLogger } from '../logger';
import type { INV1Violation } from '../prompts/PromptBuilder';
import type { SessionStore } from '../session/SessionStore';
import type { AssistantMessage, FilePart, MessageWithParts, TextPart, ToolPart, ToolStateCompleted } from '../session/types';
import type { StreamPublisher } from '../streaming';

const synthLog = createLogger('SynthesizeOrphans');

/**
 * Generic tool result (provider-agnostic)
 */
export interface GenericToolResult {
  toolCallId: string;
  output: string;
  isError?: boolean;
  attachments?: FilePart[];
}

/**
 * Message Processor - Manages assistant message lifecycle
 *
 * the previous implementation equivalent: createProcessor() return value
 * Handles:
 * - Creating assistant message
 * - Processing stream events (text, tools)
 * - Updating parts in real-time
 * - Finishing message with metadata
 */
export class MessageProcessor {
  private currentMessage?: AssistantMessage;
  private currentTextPart?: TextPart;
  private toolCalls = new Map<string, ToolPart>();
  private blocked = false;
  private seedConsumed = false;

  constructor(
    private sessionStore: SessionStore,
    private sessionID: string,
    private abortSignal: AbortSignal,
    private streamPublisher?: StreamPublisher,
    private streamContext?: {
      channelId: string;
      userId: string;
      threadId?: number;
    },
    private getMcpIdForTool?: (toolName: string) => string | undefined,
  ) {}

  /**
   * Create new assistant message
   * the previous implementation: processor.next()
   *
   * `seedId` (optional) is only honored on the first call so the caller
   * can align the session-store id with the channel-store id.
   */
  async next(seedId?: string): Promise<AssistantMessage> {
    const { generateAscendingID } = await import('../session/types');

    const useSeed = !this.seedConsumed && seedId;
    this.seedConsumed = true;
    const msg: AssistantMessage = {
      id: useSeed ? seedId! : generateAscendingID('message'),
      sessionID: this.sessionID,
      role: 'assistant',
      time: {
        created: Date.now(),
      },
      system: [], // Will be set by ConversationManager
      modelID: '', // Will be set from response
      providerID: '', // Will be set from response
      mode: 'build', // Default mode
      path: {
        cwd: process.cwd(),
        root: process.cwd(),
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };

    await this.sessionStore.writeMessage(msg);
    this.currentMessage = msg;

    console.log(`🤖 Assistant message created: ${msg.id}`);
    return msg;
  }

  /**
   * Handle text chunk from LLM stream
   * the previous implementation: case 'text-delta'
   */
  async handleTextChunk(text: string): Promise<void> {
    const { generateAscendingID } = await import('../session/types');

    if (!this.currentMessage) {
      throw new Error('No current message - call next() first');
    }

    // Create new text part if needed
    if (!this.currentTextPart) {
      this.currentTextPart = {
        id: generateAscendingID('part'),
        sessionID: this.sessionID,
        messageID: this.currentMessage.id,
        type: 'text',
        text: '',
        time: {
          start: Date.now(),
        },
      };
    }

    // Append text
    this.currentTextPart.text += text;

    // Publish to stream (real-time transport updates)
    if (this.streamPublisher && this.streamContext) {
      this.streamPublisher.publishTextChunk(
        this.sessionID,
        this.streamContext.channelId,
        this.streamContext.userId,
        this.streamContext.threadId,
        text,
      );
    }

    // Save to storage (real-time update)
    await this.sessionStore.writePart(this.currentTextPart);
  }

  /**
   * Finish current text part
   * the previous implementation: case 'text-end'
   */
  async finishTextPart(): Promise<void> {
    if (this.currentTextPart) {
      this.currentTextPart.text = this.currentTextPart.text.trimEnd();
      this.currentTextPart.time!.end = Date.now();
      await this.sessionStore.writePart(this.currentTextPart);

      // Publish text_complete event with full content
      if (this.streamPublisher && this.streamContext) {
        this.streamPublisher.publishTextComplete(
          this.sessionID,
          this.streamContext.channelId,
          this.streamContext.userId,
          this.streamContext.threadId,
          this.currentTextPart.text,
          this.currentTextPart.id,
        );
      }

      this.currentTextPart = undefined;
    }
  }

  /**
   * Handle tool call from LLM
   * the previous implementation: case 'tool-call'
   */
  async handleToolCall(toolCall: ToolCall): Promise<void> {
    const { generateAscendingID } = await import('../session/types');

    if (!this.currentMessage) {
      throw new Error('No current message - call next() first');
    }

    // Finish any pending text part before starting tool
    // This prevents text concatenation when pattern is: text -> tool -> text
    await this.finishTextPart();

    // Create tool part
    const toolPart: ToolPart = {
      id: generateAscendingID('part'),
      sessionID: this.sessionID,
      messageID: this.currentMessage.id,
      type: 'tool',
      tool: toolCall.name,
      callID: toolCall.id,
      ...(toolCall.metadata && { metadata: toolCall.metadata }),
      state: {
        status: 'running',
        input: toolCall.input,
        title: '',
        metadata: {},
        time: {
          start: Date.now(),
        },
      },
    };

    // Publish tool start to stream, then flush to ensure the async handler
    // (handleStreamEvent) finishes saving+broadcasting the tool message before
    // executeTool() runs.  Without this, tool_status_update(pending_permission)
    // can race ahead of the initial message events (Gemini race condition fix).
    //
    // GAP-16 defense: a silent failure of flushCallbacks (rejected promise, WS
    // disconnect, downstream throw) would leave the frontend without the
    // initial tool_start event but executeTool would still run — the exact
    // signature of TER-42 ("a veces no se recibe el final de las tools por
    // streaming"). Wrap so we never swallow the error silently.
    if (this.streamPublisher && this.streamContext) {
      try {
        this.streamPublisher.publishToolStart(
          this.sessionID,
          this.streamContext.channelId,
          this.streamContext.userId,
          this.streamContext.threadId,
          toolCall.id,
          toolCall.name,
          toolCall.input,
        );
        await this.streamPublisher.flushCallbacks();
      } catch (err) {
        console.error(
          `[MessageProcessor] flushCallbacks failed for tool_start (${toolCall.name}, ${toolCall.id}) — ` +
            `executeTool will proceed but the frontend may not see the initial event. ` +
            `Possible TER-42 root cause if recurring.`,
          err,
        );
      }
    }

    await this.sessionStore.writePart(toolPart);
    this.toolCalls.set(toolCall.id, toolPart);

    console.log(`🔧 Tool call: ${toolCall.name}`);
  }

  /**
   * Get all tool calls from current message
   */
  getToolCalls(): ToolPart[] {
    return Array.from(this.toolCalls.values());
  }

  /**
   * Handle tool result
   * the previous implementation: case 'tool-result'
   */
  async handleToolResult(result: GenericToolResult): Promise<void> {
    const toolPart = this.toolCalls.get(result.toolCallId);
    if (!toolPart || toolPart.state.status !== 'running') {
      console.warn(`⚠️ Tool result for unknown/finished call: ${result.toolCallId}`);
      return;
    }

    // Update tool part state
    if (result.isError) {
      toolPart.state = {
        status: 'error',
        input: toolPart.state.input,
        error: result.output,
        time: {
          start: toolPart.state.time!.start,
          end: Date.now(),
        },
      };
    } else {
      const completedState: ToolStateCompleted = {
        status: 'completed',
        input: toolPart.state.input,
        output: result.output,
        title: '',
        metadata: {},
        time: {
          start: toolPart.state.time!.start,
          end: Date.now(),
        },
      };
      if (result.attachments && result.attachments.length > 0) {
        completedState.attachments = result.attachments;
      }
      toolPart.state = completedState;
    }

    await this.sessionStore.writePart(toolPart);

    // Publish tool_complete event
    if (this.streamPublisher && this.streamContext) {
      this.streamPublisher.publishToolComplete(
        this.sessionID,
        this.streamContext.channelId,
        this.streamContext.userId,
        this.streamContext.threadId,
        toolPart.callID,
        result.isError ? 'failed' : 'completed',
        result.isError ? undefined : result.output,
        result.isError ? result.output : undefined,
        toolPart.state.time?.end ? toolPart.state.time.end - toolPart.state.time.start : undefined,
        result.attachments,
      );
    }

    this.toolCalls.delete(result.toolCallId);

    const status = result.isError ? '❌' : '✅';
    console.log(`${status} Tool result: ${toolPart.tool}`);
  }

  /**
   * Finish the assistant message
   * the previous implementation: processor.end() + result assembly
   */
  async finish(response: LLMResponse): Promise<MessageWithParts> {
    if (!this.currentMessage) {
      throw new Error('No current message - call next() first');
    }

    // Finish any pending text part
    await this.finishTextPart();

    // Update message with metadata
    this.currentMessage.time.completed = Date.now();

    if (response.metadata) {
      this.currentMessage.modelID = response.metadata.model || '';
      // Provider ID will be set by ConversationManager

      if (response.usage) {
        this.currentMessage.tokens = {
          input: response.usage.inputTokens,
          output: response.usage.outputTokens,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        };
      }

      // Cost calculation would need to be done by provider
      this.currentMessage.cost = 0;
    }

    await this.sessionStore.writeMessage(this.currentMessage);

    // Get all parts
    const parts = await this.sessionStore.listParts(this.currentMessage.id);

    console.log(`✅ Assistant message finished: ${this.currentMessage.id}`);

    return {
      info: this.currentMessage,
      parts: parts,
      blocked: this.blocked,
    };
  }

  /**
   * Mark as blocked (e.g., permission denied)
   * the previous implementation: blocked = true
   */
  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
  }

  /**
   * Get current message (for access during processing)
   */
  get message(): AssistantMessage {
    if (!this.currentMessage) {
      throw new Error('No current message - call next() first');
    }
    return this.currentMessage;
  }
}

// INV-1 remediation. Idempotent retry: writePart with a synthetic
// ToolPart in `state.status='error'` + `meta.synthetic=true` is a no-op
// upsert if the same content is already persisted.

const SYNTHESIZE_MAX_ATTEMPTS = 3;
const SYNTHESIZE_BACKOFFS_MS = [500, 1500, 4500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSynthetic(violation: INV1Violation): ToolPart {
  const existing = violation.toolPart;
  // assertInvariantINV1 only emits orphan_running / orphan_pending_approval,
  // both of which carry time.start. Defensive optional chain is for any
  // future state variants without time.
  const stateWithTime = existing.state as { time?: { start?: number }; input?: unknown };
  const startTime = stateWithTime.time?.start ?? Date.now();
  const message =
    violation.reason === 'orphan_pending_approval'
      ? 'User cancelled before approval (auto-recovered by INV-1 guard).'
      : 'Tool execution did not complete (auto-recovered by INV-1 guard).';

  return {
    ...existing,
    state: {
      status: 'error',
      input: stateWithTime.input,
      error: message,
      time: { start: startTime, end: Date.now() },
    },
    meta: {
      ...((existing as { meta?: Record<string, unknown> }).meta ?? {}),
      synthetic: true,
      syntheticReason: 'inv1_recovery',
    },
  } as ToolPart;
}

/**
 * Persist synthetic `tool_result`s for every orphan `tool_use`.
 * Idempotent retry; throws when the budget is exhausted (caller must
 * surface the error and reload from the store before calling the LLM).
 */
export async function synthesizeOrphans(
  sessionStore: SessionStore,
  sessionID: string,
  violations: readonly INV1Violation[],
): Promise<void> {
  if (violations.length === 0) return;

  let remaining = [...violations];
  let attempt = 0;
  while (remaining.length > 0 && attempt < SYNTHESIZE_MAX_ATTEMPTS) {
    const stillPending: INV1Violation[] = [];
    for (const v of remaining) {
      const synthetic = buildSynthetic(v);
      try {
        await sessionStore.writePart(synthetic);
      } catch (err) {
        stillPending.push(v);
        synthLog.warn(
          {
            sessionID,
            callID: v.toolPart.callID,
            messageId: v.messageId,
            attempt,
            error: err instanceof Error ? err.message : String(err),
          },
          'writePart failed, will retry',
        );
      }
    }
    remaining = stillPending;
    attempt += 1;
    if (remaining.length > 0 && attempt < SYNTHESIZE_MAX_ATTEMPTS) {
      const delay = SYNTHESIZE_BACKOFFS_MS[attempt - 1] ?? 5000;
      // Jitter ±200ms to avoid thundering herd from sibling channels.
      const jitter = Math.floor(Math.random() * 400) - 200;
      await sleep(delay + jitter);
    }
  }

  if (remaining.length > 0) {
    synthLog.error(
      {
        sessionID,
        remainingCount: remaining.length,
        attempts: SYNTHESIZE_MAX_ATTEMPTS,
        callIDs: remaining.map((v) => v.toolPart.callID),
      },
      'synthesizeOrphans exhausted retries',
    );
    throw new Error(
      `INV-1 recovery failed after ${SYNTHESIZE_MAX_ATTEMPTS} attempts; ` +
        `${remaining.length} orphans persist in session ${sessionID}`,
    );
  }

  synthLog.info(
    {
      sessionID,
      violationCount: violations.length,
    },
    'INV-1 auto-recovered',
  );
}
