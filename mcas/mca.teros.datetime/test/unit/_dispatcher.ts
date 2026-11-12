/**
 * Test dispatcher — mirrors the SDK's error contract for unit tests.
 *
 * The old tests drove `handleToolCall` from `mcp/src/handlers.ts`, which
 * caught every error and returned `{ content, isError: true }`. The SDK
 * transports do the same at the transport layer (not in the handler):
 *   - HTTP (http-server.ts): catch → `{ success: false, error: { message } }`
 *   - stdio (stdio-server.ts): catch → `{ content: [{ text: "Error: msg" }], isError: true }`
 *
 * This dispatcher reproduces the stdio shape so the contract tests keep
 * asserting the exact same behavior without spinning up a transport.
 */

import { TOOL_REGISTRY } from '../../src/tools';

export type DispatcherResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

export async function handleToolCall(name: string, args: unknown): Promise<DispatcherResult> {
  const entry = TOOL_REGISTRY.find((t) => t.name === name);
  if (!entry) {
    return {
      content: [{ type: 'text', text: `Error: Tool '${name}' not found` }],
      isError: true,
    };
  }

  try {
    const result = await entry.tool.handler(args as Record<string, unknown>, {} as never);
    return result as DispatcherResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}
