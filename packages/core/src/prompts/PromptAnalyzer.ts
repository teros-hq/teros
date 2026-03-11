/**
 * Prompt Analyzer
 *
 * Analyzes the components of a prompt to calculate token breakdown.
 * Used for visualizing context window usage in the UI.
 *
 * Categories:
 * - System: Base system prompt + agent identity/personality
 * - Tools: MCP tool descriptions
 * - Examples: Few-shot examples
 * - Memory: Retrieved knowledge/context
 * - Summary: Compacted conversation summary
 * - Conversation: User messages in history
 * - ToolCalls: Tool call inputs (JSON arguments)
 * - ToolResults: Tool execution outputs
 * - Output: Assistant text responses
 */

import { estimateTokens } from '@teros/shared';
import type { ToolDefinition } from '../llm/ILLMClient';
import type { MessageWithParts, TextPart, ToolPart } from '../session/types';

/**
 * Token breakdown by category
 */
export interface TokenBreakdown {
  system: number;
  tools: number;
  examples: number;
  memory: number;
  summary: number;
  conversation: number;
  toolCalls?: number;
  toolResults?: number;
  output?: number;
}

/**
 * Components that make up a prompt
 */
export interface PromptComponents {
  /** System prompt (identity, personality, constraints, environment) */
  systemPrompt: string;
  /** MCP tools available to the agent */
  tools?: ToolDefinition[];
  /** Few-shot examples */
  examples?: string;
  /** Memory context (retrieved knowledge) */
  memoryContext?: string;
  /** Compacted conversation summary */
  summary?: string;
  /** Conversation history */
  messages?: MessageWithParts[];
}

/**
 * Result of prompt analysis
 */
export interface PromptAnalysis {
  /** Token breakdown by category */
  breakdown: TokenBreakdown;
  /** Total tokens */
  total: number;
  /** Detailed token counts for debugging */
  details: {
    systemPromptLength: number;
    toolCount: number;
    toolDescriptionsLength: number;
    examplesLength: number;
    memoryContextLength: number;
    summaryLength: number;
    messageCount: number;
    userMessagesLength: number;
    assistantMessagesLength: number;
    toolCallsLength: number;
    toolResultsLength: number;
  };
}

export class PromptAnalyzer {
  /**
   * Analyze prompt components and calculate token breakdown
   */
  analyze(components: PromptComponents): PromptAnalysis {
    // Calculate system tokens
    const systemTokens = estimateTokens(components.systemPrompt || '');

    // Calculate tools tokens (definitions)
    const toolsDescription = this.serializeTools(components.tools);
    const toolsTokens = estimateTokens(toolsDescription);

    // Calculate examples tokens
    const examplesTokens = estimateTokens(components.examples || '');

    // Calculate memory tokens
    const memoryTokens = estimateTokens(components.memoryContext || '');

    // Calculate summary tokens
    const summaryTokens = estimateTokens(components.summary || '');

    // Calculate conversation tokens with detailed breakdown
    const conversationBreakdown = this.analyzeConversation(components.messages);

    const breakdown: TokenBreakdown = {
      system: systemTokens,
      tools: toolsTokens,
      examples: examplesTokens,
      memory: memoryTokens,
      summary: summaryTokens,
      conversation: conversationBreakdown.userTokens,
      toolCalls: conversationBreakdown.toolCallsTokens,
      toolResults: conversationBreakdown.toolResultsTokens,
      output: conversationBreakdown.assistantTokens,
    };

    const total =
      systemTokens +
      toolsTokens +
      examplesTokens +
      memoryTokens +
      summaryTokens +
      conversationBreakdown.userTokens +
      conversationBreakdown.assistantTokens +
      conversationBreakdown.toolCallsTokens +
      conversationBreakdown.toolResultsTokens;

    return {
      breakdown,
      total,
      details: {
        systemPromptLength: (components.systemPrompt || '').length,
        toolCount: components.tools?.length || 0,
        toolDescriptionsLength: toolsDescription.length,
        examplesLength: (components.examples || '').length,
        memoryContextLength: (components.memoryContext || '').length,
        summaryLength: (components.summary || '').length,
        messageCount: components.messages?.length || 0,
        userMessagesLength: conversationBreakdown.userLength,
        assistantMessagesLength: conversationBreakdown.assistantLength,
        toolCallsLength: conversationBreakdown.toolCallsLength,
        toolResultsLength: conversationBreakdown.toolResultsLength,
      },
    };
  }

  /**
   * Serialize tools to text for token estimation
   */
  private serializeTools(tools?: ToolDefinition[]): string {
    if (!tools || tools.length === 0) return '';

    return tools
      .map((tool) => {
        const params = tool.input_schema ? JSON.stringify(tool.input_schema, null, 2) : '';
        return `Tool: ${tool.name}\nDescription: ${tool.description || ''}\nParameters: ${params}`;
      })
      .join('\n\n');
  }

  /**
   * Analyze conversation history with detailed breakdown
   * Separates: user messages, assistant text, tool calls, tool results
   */
  private analyzeConversation(messages?: MessageWithParts[]): {
    userTokens: number;
    assistantTokens: number;
    toolCallsTokens: number;
    toolResultsTokens: number;
    userLength: number;
    assistantLength: number;
    toolCallsLength: number;
    toolResultsLength: number;
  } {
    if (!messages || messages.length === 0) {
      return {
        userTokens: 0,
        assistantTokens: 0,
        toolCallsTokens: 0,
        toolResultsTokens: 0,
        userLength: 0,
        assistantLength: 0,
        toolCallsLength: 0,
        toolResultsLength: 0,
      };
    }

    let userText = '';
    let assistantText = '';
    let toolCallsText = '';
    let toolResultsText = '';

    for (const msg of messages) {
      const role = msg.info.role;

      for (const part of msg.parts) {
        if (part.type === 'text') {
          const text = (part as TextPart).text || '';
          if (role === 'user') {
            userText += text + '\n';
          } else if (role === 'assistant') {
            assistantText += text + '\n';
          }
        } else if (part.type === 'tool') {
          const toolPart = part as ToolPart;
          const state = toolPart.state as any;

          // Tool call input (JSON arguments)
          if (state?.input) {
            const inputJson = JSON.stringify(state.input);
            toolCallsText += `${toolPart.tool}(${inputJson})\n`;
          }

          // Tool result output
          if (state?.status === 'completed' && state?.output) {
            toolResultsText += `${state.output}\n`;
          } else if (state?.status === 'error' && state?.error) {
            toolResultsText += `Error: ${state.error}\n`;
          }
        }
      }
    }

    return {
      userTokens: estimateTokens(userText),
      assistantTokens: estimateTokens(assistantText),
      toolCallsTokens: estimateTokens(toolCallsText),
      toolResultsTokens: estimateTokens(toolResultsText),
      userLength: userText.length,
      assistantLength: assistantText.length,
      toolCallsLength: toolCallsText.length,
      toolResultsLength: toolResultsText.length,
    };
  }

  /**
   * Quick estimate without full analysis
   * Useful for real-time updates during streaming
   */
  quickEstimate(
    systemPrompt: string,
    toolCount: number,
    messageCount: number,
    avgToolDescriptionTokens: number = 200,
    avgMessageTokens: number = 500,
  ): TokenBreakdown {
    return {
      system: estimateTokens(systemPrompt),
      tools: toolCount * avgToolDescriptionTokens,
      examples: 0,
      memory: 0,
      summary: 0,
      conversation: messageCount * avgMessageTokens,
      toolCalls: 0,
      toolResults: 0,
      output: 0,
    };
  }
}

// Singleton instance for convenience
export const promptAnalyzer = new PromptAnalyzer();
