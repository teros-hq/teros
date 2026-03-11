/**
 * LLM Recording System
 *
 * Records and plays back LLM API calls for testing.
 * This allows running E2E tests without making actual API calls.
 *
 * Usage:
 * 1. Recording Mode: Use RecordingLLMAdapter to wrap a real adapter
 * 2. Playback Mode: Use MockLLMAdapter to replay recorded responses
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { ILLMClient, LLMResponse, StreamMessageOptions, ToolCall } from '../llm/ILLMClient';

/**
 * Recorded LLM call
 */
export interface RecordedCall {
  /** Hash of input for matching */
  inputHash: string;
  /** Original input (for debugging) */
  input: {
    messages: any[];
    tools?: any[];
    systemPrompt?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
  /** Recorded streaming events */
  events: RecordedEvent[];
  /** Final response */
  response: LLMResponse;
  /** Timestamp when recorded */
  recordedAt: string;
}

export type RecordedEvent =
  | { type: 'text'; chunk: string; delay?: number }
  | { type: 'text_end'; delay?: number }
  | { type: 'tool_call'; toolCall: ToolCall; delay?: number };

/**
 * Recording file format
 */
export interface Recording {
  version: '1.0';
  calls: RecordedCall[];
  metadata: {
    createdAt: string;
    description?: string;
  };
}

/**
 * Create a hash from LLM input for matching recordings
 */
export function hashInput(options: StreamMessageOptions): string {
  // Normalize messages to remove timestamps and IDs that would vary
  const normalized = {
    messages: options.messages.map((m) => ({
      role: m.info.role,
      parts: m.parts.map((p) => {
        if (p.type === 'text') return { type: 'text', text: (p as any).text };
        if (p.type === 'tool')
          return {
            type: 'tool',
            name: (p as any).tool,
            input: (p as any).state?.input,
          };
        return { type: p.type };
      }),
    })),
    tools: options.tools?.map((t) => t.name).sort(),
    // Ignore systemPrompt variations - they often contain dynamic content
  };

  const json = JSON.stringify(normalized, null, 0);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

/**
 * Recording LLM Adapter - Wraps a real adapter and records calls
 */
export class RecordingLLMAdapter implements ILLMClient {
  private calls: RecordedCall[] = [];

  constructor(
    private realAdapter: ILLMClient,
    private recordingPath?: string,
  ) {}

  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    const inputHash = hashInput(options);
    const events: RecordedEvent[] = [];

    // Wrap callbacks to record events
    const originalCallbacks = options.callbacks;
    const wrappedCallbacks = {
      onText: async (chunk: string) => {
        events.push({ type: 'text', chunk });
        await originalCallbacks?.onText?.(chunk);
      },
      onTextEnd: async () => {
        events.push({ type: 'text_end' });
        await originalCallbacks?.onTextEnd?.();
      },
      onToolCall: async (toolCall: ToolCall) => {
        events.push({ type: 'tool_call', toolCall });
        await originalCallbacks?.onToolCall?.(toolCall);
      },
      onThinking: originalCallbacks?.onThinking,
    };

    // Call real adapter
    const response = await this.realAdapter.streamMessage({
      ...options,
      callbacks: wrappedCallbacks,
    });

    // Record the call
    const recordedCall: RecordedCall = {
      inputHash,
      input: {
        messages: options.messages.map((m) => ({
          role: m.info.role,
          parts: m.parts,
        })),
        tools: options.tools,
        systemPrompt: options.systemPrompt,
        model: options.model,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      },
      events,
      response,
      recordedAt: new Date().toISOString(),
    };

    this.calls.push(recordedCall);

    return response;
  }

  getProviderInfo() {
    return {
      ...this.realAdapter.getProviderInfo(),
      recording: true,
    };
  }

  /**
   * Get all recorded calls
   */
  getRecordedCalls(): RecordedCall[] {
    return this.calls;
  }

  /**
   * Save recordings to file
   */
  saveRecording(path?: string): void {
    const filePath = path || this.recordingPath;
    if (!filePath) {
      throw new Error('No recording path specified');
    }

    const recording: Recording = {
      version: '1.0',
      calls: this.calls,
      metadata: {
        createdAt: new Date().toISOString(),
      },
    };

    // Ensure directory exists
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(filePath, JSON.stringify(recording, null, 2));
    console.log(`Recording saved to ${filePath}`);
  }
}

/**
 * Mock LLM Adapter - Replays recorded responses
 */
export class MockLLMAdapter implements ILLMClient {
  private recording: Recording;
  private callIndex = 0;
  private mode: 'sequential' | 'hash-match' = 'hash-match';

  constructor(
    recordingOrPath: Recording | string,
    options?: { mode?: 'sequential' | 'hash-match' },
  ) {
    if (typeof recordingOrPath === 'string') {
      const content = readFileSync(recordingOrPath, 'utf-8');
      this.recording = JSON.parse(content);
    } else {
      this.recording = recordingOrPath;
    }

    if (options?.mode) {
      this.mode = options.mode;
    }
  }

  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    let call: RecordedCall | undefined;

    if (this.mode === 'sequential') {
      call = this.recording.calls[this.callIndex++];
    } else {
      // Hash match mode - find matching call
      const inputHash = hashInput(options);
      call = this.recording.calls.find((c) => c.inputHash === inputHash);

      if (!call) {
        // Try to find by partial match (same number of messages)
        const msgCount = options.messages.length;
        call = this.recording.calls.find((c) => c.input.messages.length === msgCount);
      }
    }

    if (!call) {
      throw new Error(
        `No recorded response found for input. ` +
          `Mode: ${this.mode}, ` +
          `Available calls: ${this.recording.calls.length}, ` +
          `Call index: ${this.callIndex}`,
      );
    }

    // Replay events with optional delays
    for (const event of call.events) {
      if (event.delay) {
        await new Promise((r) => setTimeout(r, event.delay));
      }

      switch (event.type) {
        case 'text':
          await options.callbacks?.onText?.(event.chunk);
          break;
        case 'text_end':
          await options.callbacks?.onTextEnd?.();
          break;
        case 'tool_call':
          await options.callbacks?.onToolCall?.(event.toolCall);
          break;
      }
    }

    return call.response;
  }

  getProviderInfo() {
    return {
      name: 'MockLLM',
      model: 'mock',
      capabilities: {
        streaming: true,
        tools: true,
        thinking: false,
      },
    };
  }

  /**
   * Reset call index (for sequential mode)
   */
  reset(): void {
    this.callIndex = 0;
  }
}

/**
 * Create a simple mock response inline (for simple tests)
 */
export function createSimpleMockAdapter(
  responses: {
    text?: string;
    toolCalls?: ToolCall[];
    stopReason?: LLMResponse['stopReason'];
  }[],
): MockLLMAdapter {
  const calls: RecordedCall[] = responses.map((r, i) => {
    const events: RecordedEvent[] = [];

    if (r.text) {
      // Split text into chunks for realistic streaming
      const chunks = r.text.match(/.{1,50}/g) || [r.text];
      for (const chunk of chunks) {
        events.push({ type: 'text', chunk });
      }
      events.push({ type: 'text_end' });
    }

    if (r.toolCalls) {
      for (const toolCall of r.toolCalls) {
        events.push({ type: 'tool_call', toolCall });
      }
    }

    return {
      inputHash: `mock-${i}`,
      input: { messages: [] },
      events,
      response: {
        stopReason: r.stopReason || (r.toolCalls ? 'tool_calls' : 'end_turn'),
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      recordedAt: new Date().toISOString(),
    };
  });

  return new MockLLMAdapter(
    {
      version: '1.0',
      calls,
      metadata: { createdAt: new Date().toISOString() },
    },
    { mode: 'sequential' },
  );
}

/**
 * Helper to load or create a recording
 */
export function loadOrCreateRecording(path: string, realAdapter?: ILLMClient): ILLMClient {
  if (existsSync(path)) {
    console.log(`Loading recording from ${path}`);
    return new MockLLMAdapter(path);
  }

  if (!realAdapter) {
    throw new Error(`Recording not found at ${path} and no real adapter provided`);
  }

  console.log(`Recording mode: will save to ${path}`);
  return new RecordingLLMAdapter(realAdapter, path);
}
