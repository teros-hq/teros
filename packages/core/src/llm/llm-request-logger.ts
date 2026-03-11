/**
 * LLM Request Logger
 * 
 * Logs LLM requests and responses to separate files for debugging.
 * Each request gets its own file with timestamp and request ID.
 * 
 * Enable with: LLM_REQUEST_LOGGING=true
 * Configure path with: LLM_REQUEST_LOG_DIR=/path/to/logs (default: ./llm-requests)
 */

import fs from 'fs';
import path from 'path';
import pino from 'pino';
import type { MessageWithParts } from '../session/types';
import type { ToolDefinition } from './ILLMClient';

// Configuration
const ENABLED = process.env.LLM_REQUEST_LOGGING === 'true';
const LOG_DIR = process.env.LLM_REQUEST_LOG_DIR || './llm-requests';

// Ensure log directory exists
if (ENABLED) {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch (error) {
    console.error('[LLMRequestLogger] Failed to create log directory:', error);
  }
}

/**
 * Request metadata
 */
export interface LLMRequestMetadata {
  requestId: string;
  channelId?: string;
  userId?: string;
  agentId?: string;
  workspaceId?: string;
  model: string;
  provider: string;
  timestamp: number;
}

/**
 * Request data to log
 */
export interface LLMRequestData {
  metadata: LLMRequestMetadata;
  systemPrompt: string;
  messages: MessageWithParts[];
  tools?: ToolDefinition[];
  cacheBreakpointIndex?: number;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Response data to log
 */
export interface LLMResponseData {
  requestId: string;
  stopReason: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  metadata?: Record<string, any>;
  error?: {
    message: string;
    type: string;
    context?: Record<string, any>;
  };
}

/**
 * Breakdown data to log
 */
export interface LLMBreakdownData {
  requestId: string;
  breakdown: {
    system: number;
    tools: number;
    examples: number;
    summary: number;
    previous?: number;
    memory: number;
    context?: number;
    latest?: number;
    conversation: number;
    toolCalls?: number;
    toolResults?: number;
    output?: number;
  };
  cacheBreakpointIndex?: number;
  messageCounts?: {
    synthetic: number;
    previous: number;
    latest: number;
    total: number;
  };
}

/**
 * Sanitize messages for logging (remove sensitive data, truncate large content)
 */
function sanitizeMessages(messages: MessageWithParts[]): any[] {
  return messages.map((msg) => ({
    role: msg.info.role,
    id: msg.info.id,
    parts: msg.parts.map((part) => {
      if (part.type === 'text') {
        // Truncate very long text
        const text = part.text || '';
        return {
          type: 'text',
          text: text.length > 1000 ? text.substring(0, 1000) + '... [truncated]' : text,
          synthetic: (part as any).synthetic,
        };
      } else if (part.type === 'tool') {
        return {
          type: 'tool',
          tool: part.tool,
          callID: part.callID,
          status: part.state.status,
          inputSize: JSON.stringify(part.state.input || {}).length,
          outputSize:
            part.state.status === 'completed'
              ? (part.state.output || '').length
              : part.state.status === 'error'
                ? (part.state.error || '').length
                : 0,
        };
      }
      return { type: part.type };
    }),
  }));
}

/**
 * Sanitize tools for logging (truncate descriptions)
 */
function sanitizeTools(tools?: ToolDefinition[]): any[] | undefined {
  if (!tools) return undefined;

  return tools.map((tool) => ({
    name: tool.name,
    description:
      tool.description.length > 200
        ? tool.description.substring(0, 200) + '... [truncated]'
        : tool.description,
    parameterCount: Object.keys(tool.input_schema.properties || {}).length,
  }));
}

/**
 * Generate filename for request
 */
function getLogFilename(metadata: LLMRequestMetadata): string {
  const date = new Date(metadata.timestamp);
  const dateStr = date.toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const channelId = metadata.channelId || 'unknown';
  return `${dateStr}_${channelId}_${metadata.requestId}.json`;
}

/**
 * Log LLM request to file
 */
export function logLLMRequest(data: LLMRequestData): void {
  if (!ENABLED) return;

  try {
    const filename = getLogFilename(data.metadata);
    const filepath = path.join(LOG_DIR, filename);

    const logData = {
      type: 'request',
      metadata: data.metadata,
      request: {
        systemPrompt: {
          length: data.systemPrompt.length,
          preview:
            data.systemPrompt.length > 500
              ? data.systemPrompt.substring(0, 500) + '... [truncated]'
              : data.systemPrompt,
        },
        messages: sanitizeMessages(data.messages),
        messageCount: data.messages.length,
        tools: sanitizeTools(data.tools),
        toolCount: data.tools?.length || 0,
        cacheBreakpointIndex: data.cacheBreakpointIndex,
        temperature: data.temperature,
        maxTokens: data.maxTokens,
      },
    };

    fs.writeFileSync(filepath, JSON.stringify(logData, null, 2));
  } catch (error) {
    console.error('[LLMRequestLogger] Failed to log request:', error);
  }
}

/**
 * Log LLM response to file (appends to request file)
 */
export function logLLMResponse(data: LLMResponseData): void {
  if (!ENABLED) return;

  try {
    // Find the request file
    const files = fs.readdirSync(LOG_DIR);
    const requestFile = files.find((f) => f.includes(data.requestId));

    if (!requestFile) {
      console.warn('[LLMRequestLogger] Request file not found for response:', data.requestId);
      return;
    }

    const filepath = path.join(LOG_DIR, requestFile);
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf-8'));

    existing.response = {
      timestamp: Date.now(),
      stopReason: data.stopReason,
      usage: data.usage,
      metadata: data.metadata,
      error: data.error,
    };

    fs.writeFileSync(filepath, JSON.stringify(existing, null, 2));
  } catch (error) {
    console.error('[LLMRequestLogger] Failed to log response:', error);
  }
}

/**
 * Log token breakdown to file (appends to request file)
 */
export function logLLMBreakdown(data: LLMBreakdownData): void {
  if (!ENABLED) return;

  try {
    // Find the request file
    const files = fs.readdirSync(LOG_DIR);
    const requestFile = files.find((f) => f.includes(data.requestId));

    if (!requestFile) {
      console.warn('[LLMRequestLogger] Request file not found for breakdown:', data.requestId);
      return;
    }

    const filepath = path.join(LOG_DIR, requestFile);
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf-8'));

    existing.breakdown = {
      timestamp: Date.now(),
      breakdown: data.breakdown,
      cacheBreakpointIndex: data.cacheBreakpointIndex,
      messageCounts: data.messageCounts,
    };

    fs.writeFileSync(filepath, JSON.stringify(existing, null, 2));
  } catch (error) {
    console.error('[LLMRequestLogger] Failed to log breakdown:', error);
  }
}

/**
 * Log raw prompt details (full system prompt, messages, tools)
 * This is the detailed version for debugging
 */
export function logRawPrompt(
  requestId: string,
  systemPrompt: string,
  messages: MessageWithParts[],
  tools?: ToolDefinition[],
): void {
  if (!ENABLED) return;

  try {
    // Find the request file
    const files = fs.readdirSync(LOG_DIR);
    const requestFile = files.find((f) => f.includes(requestId));

    if (!requestFile) {
      console.warn('[LLMRequestLogger] Request file not found for raw prompt:', requestId);
      return;
    }

    const filepath = path.join(LOG_DIR, requestFile);
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf-8'));

    existing.rawPrompt = {
      timestamp: Date.now(),
      systemPrompt,
      messages: messages.map((msg) => ({
        role: msg.info.role,
        id: msg.info.id,
        parts: msg.parts,
      })),
      tools: tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      })),
    };

    fs.writeFileSync(filepath, JSON.stringify(existing, null, 2));
  } catch (error) {
    console.error('[LLMRequestLogger] Failed to log raw prompt:', error);
  }
}

/**
 * Create a console logger that conditionally logs to file
 */
export const llmRequestLogger = {
  enabled: ENABLED,
  logDir: LOG_DIR,

  /**
   * Log a request
   */
  request: logLLMRequest,

  /**
   * Log a response
   */
  response: logLLMResponse,

  /**
   * Log token breakdown
   */
  breakdown: logLLMBreakdown,

  /**
   * Log raw prompt (detailed)
   */
  rawPrompt: logRawPrompt,

  /**
   * Info log
   */
  info: (message: string, data?: Record<string, any>) => {
    if (ENABLED) {
      console.log(`[LLMRequestLogger] ${message}`, data || '');
    }
  },
};
