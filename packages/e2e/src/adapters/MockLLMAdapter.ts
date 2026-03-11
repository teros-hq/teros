/**
 * Mock LLM Adapter for E2E Testing
 *
 * Implements ILLMClient interface to simulate LLM responses without
 * making actual API calls. Supports:
 * - Predefined responses
 * - Tool call simulation
 * - Streaming simulation
 * - Response delays for realistic testing
 */

import type {
  ILLMClient,
  LLMResponse,
  StreamMessageOptions,
  ToolCall,
  ToolDefinition,
} from '@teros/core/llm/ILLMClient';

export interface MockResponse {
  /** Text content to return */
  text?: string;
  /** Tool calls to simulate */
  toolCalls?: ToolCall[];
  /** Delay in ms before responding */
  delay?: number;
  /** Stop reason */
  stopReason?: LLMResponse['stopReason'];
  /** Simulate an error */
  error?: string;
}

export interface MockLLMConfig {
  /** Default response when no specific match */
  defaultResponse?: MockResponse;
  /** Responses keyed by message content pattern (regex) */
  responses?: Map<RegExp, MockResponse>;
  /** Delay between streaming chunks (ms) */
  streamingDelay?: number;
  /** Model name to report */
  modelName?: string;
}

/**
 * Mock LLM Adapter for testing
 *
 * Usage:
 * ```ts
 * const mock = new MockLLMAdapter({
 *   defaultResponse: { text: 'Hello! How can I help?' },
 *   responses: new Map([
 *     [/weather/i, { text: 'The weather is sunny!' }],
 *     [/calculate/i, {
 *       toolCalls: [{ id: 'tc_1', name: 'calculator', input: { expression: '2+2' } }]
 *     }],
 *   ])
 * });
 * ```
 */
export class MockLLMAdapter implements ILLMClient {
  private config: MockLLMConfig;
  private callHistory: StreamMessageOptions[] = [];

  constructor(config: MockLLMConfig = {}) {
    this.config = {
      defaultResponse: { text: 'Mock response from test LLM' },
      streamingDelay: 10,
      modelName: 'mock-llm-v1',
      ...config,
    };
  }

  /**
   * Get all calls made to this mock (for assertions)
   */
  getCallHistory(): StreamMessageOptions[] {
    return this.callHistory;
  }

  /**
   * Clear call history
   */
  clearHistory(): void {
    this.callHistory = [];
  }

  /**
   * Add a response pattern dynamically
   */
  addResponse(pattern: RegExp, response: MockResponse): void {
    if (!this.config.responses) {
      this.config.responses = new Map();
    }
    this.config.responses.set(pattern, response);
  }

  /**
   * Set the default response
   */
  setDefaultResponse(response: MockResponse): void {
    this.config.defaultResponse = response;
  }

  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    // Record the call
    this.callHistory.push(options);

    // Find matching response
    const response = this.findMatchingResponse(options);

    // Handle errors
    if (response.error) {
      throw new Error(response.error);
    }

    // Simulate delay
    if (response.delay) {
      await this.sleep(response.delay);
    }

    // Check for abort
    if (options.signal?.aborted) {
      return { stopReason: 'error' };
    }

    // Stream text if present
    if (response.text && options.callbacks?.onText) {
      await this.streamText(response.text, options);
    }

    // Handle tool calls
    if (response.toolCalls?.length && options.callbacks?.onToolCall) {
      for (const toolCall of response.toolCalls) {
        await options.callbacks.onToolCall(toolCall);
      }
    }

    // Call onTextEnd if we had text
    if (response.text && options.callbacks?.onTextEnd) {
      await options.callbacks.onTextEnd();
    }

    return {
      stopReason: response.stopReason || (response.toolCalls?.length ? 'tool_calls' : 'end_turn'),
      usage: {
        inputTokens: this.estimateTokens(options.messages),
        outputTokens: this.estimateTokens([{ text: response.text || '' }]),
      },
    };
  }

  getProviderInfo() {
    return {
      name: 'mock',
      model: this.config.modelName || 'mock-llm-v1',
      isTest: true,
    };
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private findMatchingResponse(options: StreamMessageOptions): MockResponse {
    // Get the last user message content
    const lastMessage = options.messages[options.messages.length - 1];
    const content = this.extractTextContent(lastMessage);

    // Check patterns
    if (this.config.responses) {
      for (const [pattern, response] of this.config.responses) {
        if (pattern.test(content)) {
          return response;
        }
      }
    }

    return this.config.defaultResponse || { text: 'Mock response' };
  }

  private extractTextContent(message: any): string {
    if (typeof message === 'string') return message;
    if (message?.content) {
      if (typeof message.content === 'string') return message.content;
      if (Array.isArray(message.content)) {
        return message.content
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join(' ');
      }
    }
    if (message?.parts) {
      return message.parts
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join(' ');
    }
    return '';
  }

  private async streamText(text: string, options: StreamMessageOptions): Promise<void> {
    const chunkSize = 10; // Characters per chunk
    const delay = this.config.streamingDelay || 10;

    for (let i = 0; i < text.length; i += chunkSize) {
      if (options.signal?.aborted) break;

      const chunk = text.slice(i, i + chunkSize);
      await options.callbacks?.onText?.(chunk);
      await this.sleep(delay);
    }
  }

  private estimateTokens(messages: any[]): number {
    // Rough estimate: 4 chars per token
    const text = messages.map((m) => this.extractTextContent(m)).join(' ');
    return Math.ceil(text.length / 4);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a simple mock that echoes back the user message
 */
export function createEchoMock(): MockLLMAdapter {
  return new MockLLMAdapter({
    defaultResponse: { text: 'Echo: I received your message' },
  });
}

/**
 * Create a mock that simulates tool usage
 */
export function createToolMock(toolResponses: Record<string, MockResponse>): MockLLMAdapter {
  const responses = new Map<RegExp, MockResponse>();

  for (const [pattern, response] of Object.entries(toolResponses)) {
    responses.set(new RegExp(pattern, 'i'), response);
  }

  return new MockLLMAdapter({
    responses,
    defaultResponse: { text: "I don't know how to help with that." },
  });
}
