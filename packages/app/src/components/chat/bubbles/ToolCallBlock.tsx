import { McaRegistry } from '../../mca';
import type { ToolCall } from './types';

/**
 * Format tool call as plain text for copy-paste
 */
export function formatToolCallText(tool: ToolCall): string {
  const lines: string[] = [];
  lines.push(
    `[${tool.toolName}] ${tool.status === 'running' ? '⏳' : tool.status === 'completed' ? '✓' : '✗'}${tool.duration ? ` (${tool.duration}ms)` : ''}`,
  );

  if (tool.input?.command) {
    lines.push(`$ ${tool.input.command}`);
  } else if (tool.input) {
    lines.push(`Input: ${JSON.stringify(tool.input, null, 2)}`);
  }

  if (tool.output && tool.status === 'completed') {
    lines.push(`Output:\n${tool.output.slice(0, 500)}${tool.output.length > 500 ? '...' : ''}`);
  }

  if (tool.error && tool.status === 'failed') {
    lines.push(`Error: ${tool.error}`);
  }

  return lines.join('\n');
}

/**
 * Render a single tool call using the MCA Registry
 * Uses custom renderers for specific MCAs or falls back to default
 * Matching is done by mcaId (not tool name) for consistency across app instances
 */
export function ToolCallBlock({ tool }: { tool: ToolCall }) {
  const Renderer = McaRegistry.getToolCallRendererByMcpId(tool.mcaId, tool.toolName);

  return (
    <Renderer
      toolCallId={tool.toolCallId}
      toolName={tool.toolName}
      input={tool.input}
      status={tool.status}
      output={tool.output}
      error={tool.error}
      duration={tool.duration}
      appId={tool.appId}
      permissionRequestId={tool.permissionRequestId}
    />
  );
}
