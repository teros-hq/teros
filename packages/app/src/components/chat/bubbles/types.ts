/**
 * Shared types and interfaces for bubble components
 */

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  /** MCP ID for renderer matching (e.g., 'mca.teros.bash') */
  mcaId?: string;
  /** App ID for permission updates */
  appId?: string;
  input?: Record<string, any>;
  /**
   * Tool execution status:
   * - pending: waiting to start (initial state)
   * - running: currently executing
   * - pending_permission: waiting for user approval
   * - completed: finished successfully
   * - failed: finished with error
   */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'pending_permission';
  output?: string;
  error?: string;
  duration?: number;
  /** Permission request ID (when status is pending_permission) */
  permissionRequestId?: string;
}

// Message content types
export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; width?: number; height?: number; caption?: string }
  | { type: 'video'; url: string; duration?: number; caption?: string; thumbnailUrl?: string }
  | { type: 'audio'; url: string; duration?: number; caption?: string; mimeType?: string }
  | {
      type: 'voice';
      url?: string;
      data?: string;
      duration?: number;
      transcription?: string;
      mimeType?: string;
    }
  | { type: 'file'; url: string; filename: string; caption?: string; mimeType?: string; size?: number }
  | { type: 'html'; html: string; caption?: string; height?: number }
  | { type: 'html_file'; filePath: string; caption?: string }
  | {
      type: 'tool_execution';
      toolCallId: string;
      toolName: string;
      mcaId?: string;
      appId?: string;
      input?: any;
      status: 'pending' | 'running' | 'pending_permission' | 'completed' | 'failed';
      output?: string;
      error?: string;
      duration?: number;
      permissionRequestId?: string;
    }
  | { type: 'event'; eventType: string; eventData: Record<string, any>; description?: string }
  | {
      type: 'error';
      errorType: 'llm' | 'tool' | 'session' | 'validation' | 'network' | 'unknown';
      userMessage: string;
      technicalMessage?: string;
      context?: Record<string, any>;
    };
