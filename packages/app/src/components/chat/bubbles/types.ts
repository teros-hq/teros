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
  status: 'pending' | 'running' | 'completed' | 'failed' | 'pending_permission' | 'pending_user_input';
  output?: string;
  error?: string;
  duration?: number;
  /** Attachments from tool execution (images, files, etc.) */
  attachments?: Array<{ url: string; mime: string; filename?: string }>;
  /** Permission request ID (when status is pending_permission) */
  permissionRequestId?: string;
  /** Inline form request ID (when status is pending_user_input — request-user-input tool) */
  formRequestId?: string;
  /**
   * Binary irreversibility marker (Renderer UX Guide v2 §8). Sourced from
   * `manifest.tools[name].annotations.irreversible` and propagated by the
   * backend in the `pending_permission` event. Surfaces an Irreversibility
   * Indicator badge in the Tool Call Card header.
   */
  irreversible?: boolean;
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
      transcriptionError?: string;
      mimeType?: string;
    }
  // FVU (spec v1.2.0): optional live volume reference — filePath present means
  // the file lives on the workspace volume (watchable, auto-refresh, share);
  // url-only messages are snapshots. Backward compatible with old messages.
  | { type: 'file'; url: string; filename: string; caption?: string; mimeType?: string; size?: number; filePath?: string; workspaceId?: string }
  | { type: 'html'; html: string; caption?: string; height?: number }
  | { type: 'html_file'; filePath: string; caption?: string; workspaceId?: string }
  | { type: 'browser_live_view'; sessionId: string; url: string; caption?: string }
  | {
      type: 'tool_execution';
      toolCallId: string;
      toolName: string;
      mcaId?: string;
      appId?: string;
      input?: any;
      status: 'pending' | 'running' | 'pending_permission' | 'pending_user_input' | 'completed' | 'failed';
      output?: string;
      error?: string;
      duration?: number;
      attachments?: Array<{ url: string; mime: string; filename?: string }>;
      permissionRequestId?: string;
      /** ISO timestamp of when the permission was requested (persisted metadata). */
      permissionRequestedAt?: string;
      /** Inline form request ID (status pending_user_input — request-user-input tool). */
      formRequestId?: string;
      /** ISO timestamp of when the form was requested (persisted metadata). */
      formRequestedAt?: string;
      /**
       * Binary irreversibility marker (Renderer UX Guide v2 §8). Set when
       * the tool's manifest declares `annotations.irreversible: true`.
       */
      irreversible?: boolean;
    }
  | { type: 'event'; eventType: string; eventData: Record<string, any>; description?: string }
  // v2 non-blocking interactions (docs/specs/20261024_non-blocking-user-interactions.md):
  // the form answer arrives as a synthetic user message of type form_response.
  | {
      type: 'form_response';
      formRequestId: string;
      values?: Record<string, any>;
      notes?: string;
      dismissed?: boolean;
    }
  | {
      type: 'error';
      errorType: 'llm' | 'tool' | 'session' | 'validation' | 'network' | 'unknown';
      userMessage: string;
      technicalMessage?: string;
      context?: Record<string, any>;
    };
