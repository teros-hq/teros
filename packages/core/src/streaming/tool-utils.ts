/**
 * Tool Utilities for Streaming
 *
 * Helper functions to categorize tools and extract file/directory locations
 * from tool inputs for enhanced visibility in transports.
 */

import type { ToolKind, ToolLocation } from './types';

/**
 * Categorizes tools into read, edit, or other
 *
 * - read: Tools that only read data (no side effects)
 * - edit: Tools that modify state (files, system)
 * - other: Everything else (MCP tools, task orchestration, etc.)
 */
export function determineToolKind(toolName: string): ToolKind {
  const normalizedName = toolName.toLowerCase();

  // Read tools - no side effects, only retrieve information
  const readTools = ['read', 'glob', 'grep', 'list', 'webfetch', 'todoread'];

  // Edit tools - modify state, create/update/delete
  const editTools = ['edit', 'write', 'bash', 'todowrite'];

  if (readTools.includes(normalizedName)) {
    return 'read';
  }

  if (editTools.includes(normalizedName)) {
    return 'edit';
  }

  // Default to 'other' for MCP tools and unknown tools
  return 'other';
}

/**
 * Extracts file/directory locations from tool inputs
 *
 * Returns array of {path} objects that can be used for:
 * - Clickable links in Telegram/UI
 * - File navigation in editors
 * - Progress indicators showing which file is being processed
 *
 * Examples:
 * - read({filePath: "/foo/bar.ts"}) -> [{path: "/foo/bar.ts"}]
 * - glob({pattern: "*.ts", path: "/src"}) -> [{path: "/src"}]
 * - edit({filePath: "/foo/bar.ts"}) -> [{path: "/foo/bar.ts"}]
 * - bash({command: "ls"}) -> [] (no file references)
 */
export function extractLocations(toolName: string, input: Record<string, any>): ToolLocation[] {
  if (!input || typeof input !== 'object') {
    return [];
  }

  const normalizedName = toolName.toLowerCase();

  try {
    switch (normalizedName) {
      // File operations with filePath parameter
      case 'read':
      case 'edit':
      case 'write':
        return input.filePath ? [{ path: input.filePath }] : [];

      // Search operations with path parameter
      case 'glob':
      case 'grep':
        return input.path ? [{ path: input.path }] : [];

      // List directory with path parameter
      case 'list':
        return input.path ? [{ path: input.path }] : [];

      // Bash - try to extract from command (basic heuristic)
      case 'bash':
        // For now, don't try to parse bash commands
        // Could be enhanced to extract file paths from commands
        return [];

      // MCP tools and others - no standard location format
      default:
        // Check for common path-like parameters
        if (input.path && typeof input.path === 'string') {
          return [{ path: input.path }];
        }
        if (input.filePath && typeof input.filePath === 'string') {
          return [{ path: input.filePath }];
        }
        if (input.file && typeof input.file === 'string') {
          return [{ path: input.file }];
        }
        if (input.directory && typeof input.directory === 'string') {
          return [{ path: input.directory }];
        }
        return [];
    }
  } catch (error) {
    // Fail silently - location extraction is best-effort
    console.warn(`Failed to extract locations from ${toolName}:`, error);
    return [];
  }
}

/**
 * Formats tool execution for display in transports
 *
 * Default format (in blockquote expandable):
 *
 * 🔵 tool_name · param1: value1, param2: value2
 *
 * {
 *   "param1": "value1",
 *   "param2": "value2"
 * }
 *
 * When completed (🟢):
 *
 * 🟢 tool_name · param1: value1, param2: value2
 *
 * {
 *   "result": "...",
 *   "output": "..."
 * }
 *
 * Note: Emoji is added by transport layer
 */
export function formatToolDisplay(
  toolName: string,
  kind: ToolKind,
  locations: ToolLocation[],
  input?: Record<string, any>,
  output?: string,
  error?: string,
): string {
  // Build first line: tool_name · params summary
  let firstLine = escapeHtml(toolName);

  // Add params summary (first 2-3 key params)
  const paramsSummary = buildParamsSummary(toolName, locations, input, output);
  if (paramsSummary) {
    firstLine += ` · ${paramsSummary}`;
  }

  // Build full content block
  let content = firstLine;

  // Add input JSON (always show if input exists)
  if (input && Object.keys(input).length > 0) {
    const inputJson = JSON.stringify(input, null, 2);
    content += '\n\n' + inputJson;
  }

  // Add output/error JSON (only when tool is completed)
  if (output || error) {
    // Both output and error are already JSON strings from the MCA
    const resultJson = error || output;

    content += '\n\n' + resultJson;
  }

  return content;
}

/**
 * Build a short summary of parameters for the first line
 *
 * For shell_exec:
 * - First tries output.description (if tool completed)
 * - Then tries input.description (if provided)
 * - Otherwise returns empty string
 *
 * For other tools:
 * - "filePath: src/index.ts"
 * - "url: https://example.com"
 */
function buildParamsSummary(
  toolName: string,
  locations: ToolLocation[],
  input?: Record<string, any>,
  output?: string,
): string {
  // Special handling for shell_exec (or just "exec")
  if (toolName === 'shell_exec' || toolName === 'exec') {
    // Try output.description first
    if (output) {
      try {
        const outputObj = JSON.parse(output);
        if (outputObj.description) {
          return outputObj.description;
        }
      } catch {
        // Not valid JSON, ignore
      }
    }

    // Try input.description second
    if (input?.description) {
      return input.description;
    }

    // Return empty string
    return '';
  }

  // File-based tools: show path
  if (locations.length > 0) {
    const path = locations[0].path.replace(/^(\.\.\/)+/, '');
    return `filePath: ${path}`;
  }

  if (!input) return '';

  // Show first 2-3 most important parameters for other tools
  const entries = Object.entries(input)
    .filter(([key, val]) => val !== undefined && val !== null)
    .slice(0, 3);

  if (entries.length === 0) return '';

  return entries
    .map(([key, val]) => {
      const valStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
      const truncated = valStr.length > 50 ? valStr.substring(0, 50) + '...' : valStr;
      return `${key}: ${truncated}`;
    })
    .join(', ');
}

/**
 * Escape HTML entities
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
