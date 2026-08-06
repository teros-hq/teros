/**
 * Shared utilities for core MCA tools.
 */

import type { ToolContext } from '@teros/mca-sdk';

/**
 * Validates that an agentId exists. Throws a clear, actionable error if not.
 *
 * Reuses the agentGet call so callers that need the agent data anyway can skip
 * this and just call context.agentGet() directly, catching the error themselves.
 *
 * @throws Error with a user-friendly message if the agent is not found.
 */
export async function validateAgentId(agentId: string, context: ToolContext): Promise<void> {
  try {
    await context.agentGet(agentId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Agent not found') || message.includes('404')) {
      throw new Error(
        `Agent ID "${agentId}" is not valid. Use list-agents or workspace-agent-list to find valid agent IDs.`,
      );
    }
    // Re-throw unrelated errors as-is
    throw error;
  }
}
