import type { ToolContext } from '@teros/mca-sdk';

/**
 * Get agentId from execution context
 * Memory is always agent-scoped, never user-scoped
 */
export function getAgentId(context: ToolContext): string {
  const { agentId } = context.execution;
  
  if (!agentId) {
    throw new Error('agentId is required in execution context for memory operations');
  }
  
  return agentId;
}

/**
 * Get optional user/channel context for filtering
 */
export function getFilterContext(context: ToolContext) {
  const { userId, channelId } = context.execution;
  return { userId, channelId };
}
