import { FORM_TOOL_NAME, UI_HIDDEN_PROXY_TOOLS } from '@teros/shared';
import { McaRegistry } from '../../mca';
import { FormWidget } from '../../mca/FormWidget';
import type { ToolCall } from './types';

/**
 * Derive the app icon URL from an mcaId.
 * Convention: every MCA ships an icon at /static/mcas/<mcaId>/icon.png.
 */
function mcaIconUrl(mcaId: string | undefined): string | undefined {
  if (!mcaId) return undefined;
  const base = process.env.EXPO_PUBLIC_BACKEND_URL ?? '';
  return `${base}/static/mcas/${mcaId}/icon.png`;
}

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
  // Tool-execution proxy discovery is invisible: list-installed-apps and
  // list-app-tools never render (execute-tool calls arrive already tunneled
  // to the target tool's name backend-side, so they resolve normally below).
  if (UI_HIDDEN_PROXY_TOOLS.includes(tool.toolName)) {
    return null;
  }

  // Built-in inline form (request-user-input) — no mcaId, so registry matching
  // does not apply; the FormWidget owns every state of this tool's lifecycle.
  if (tool.toolName === FORM_TOOL_NAME) {
    return <FormWidget tool={tool} />;
  }

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
      attachments={tool.attachments}
      appId={tool.appId}
      appIcon={mcaIconUrl(tool.mcaId)}
      permissionRequestId={tool.permissionRequestId}
      irreversible={tool.irreversible}
    />
  );
}
