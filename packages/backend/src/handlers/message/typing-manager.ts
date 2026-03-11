/**
 * Typing Indicator Manager
 *
 * Manages typing indicators with heartbeat for long-running operations.
 */

export interface TypingManagerDeps {
  broadcastToChannel: (channelId: string, message: any) => void;
}

/**
 * Creates a typing indicator manager for a channel
 */
export function createTypingManager(
  channelId: string,
  agentId: string,
  deps: TypingManagerDeps,
  heartbeats: Map<string, ReturnType<typeof setInterval>>,
) {
  const { broadcastToChannel } = deps;

  return {
    /**
     * Start typing indicator with heartbeat
     * Clears any existing heartbeat for this channel first
     */
    start(): void {
      // Clear any existing heartbeat for this channel first
      const existingInterval = heartbeats.get(channelId);
      if (existingInterval) {
        clearInterval(existingInterval);
      }

      // Send initial typing indicator
      broadcastToChannel(channelId, {
        type: 'typing',
        channelId,
        agentId,
        isTyping: true,
      });

      // Start new heartbeat interval (every 10 seconds)
      const interval = setInterval(() => {
        broadcastToChannel(channelId, {
          type: 'typing',
          channelId,
          agentId,
          isTyping: true,
        });
      }, 10000);

      heartbeats.set(channelId, interval);
    },

    /**
     * Stop typing indicator and clear heartbeat
     */
    stop(): void {
      const existingInterval = heartbeats.get(channelId);
      if (existingInterval) {
        clearInterval(existingInterval);
        heartbeats.delete(channelId);
      }
      broadcastToChannel(channelId, {
        type: 'typing',
        channelId,
        agentId,
        isTyping: false,
      });
    },
  };
}

export type TypingManager = ReturnType<typeof createTypingManager>;
