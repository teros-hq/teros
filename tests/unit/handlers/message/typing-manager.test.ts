/**
 * Tests for TypingManager
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createTypingManager } from '../../../../packages/backend/src/handlers/message/typing-manager';

describe('TypingManager', () => {
  let broadcastMock: ReturnType<typeof mock>;
  let heartbeats: Map<string, ReturnType<typeof setInterval>>;

  const channelId = 'ch_test123';
  const agentId = 'agent_test456';

  beforeEach(() => {
    broadcastMock = mock(() => {});
    heartbeats = new Map();
  });

  it('should send typing:true on start', () => {
    const manager = createTypingManager(
      channelId,
      agentId,
      { broadcastToChannel: broadcastMock },
      heartbeats,
    );

    manager.start();

    expect(broadcastMock).toHaveBeenCalledWith(channelId, {
      type: 'typing',
      channelId,
      agentId,
      isTyping: true,
    });
  });

  it('should send typing:false on stop', () => {
    const manager = createTypingManager(
      channelId,
      agentId,
      { broadcastToChannel: broadcastMock },
      heartbeats,
    );

    manager.start();
    broadcastMock.mockClear();
    manager.stop();

    expect(broadcastMock).toHaveBeenCalledWith(channelId, {
      type: 'typing',
      channelId,
      agentId,
      isTyping: false,
    });
  });

  it('should register heartbeat interval on start', () => {
    const manager = createTypingManager(
      channelId,
      agentId,
      { broadcastToChannel: broadcastMock },
      heartbeats,
    );

    manager.start();

    expect(heartbeats.has(channelId)).toBe(true);
  });

  it('should clear heartbeat interval on stop', () => {
    const manager = createTypingManager(
      channelId,
      agentId,
      { broadcastToChannel: broadcastMock },
      heartbeats,
    );

    manager.start();
    expect(heartbeats.has(channelId)).toBe(true);

    manager.stop();
    expect(heartbeats.has(channelId)).toBe(false);
  });

  it('should clear existing heartbeat before starting new one', () => {
    const manager = createTypingManager(
      channelId,
      agentId,
      { broadcastToChannel: broadcastMock },
      heartbeats,
    );

    manager.start();
    const firstInterval = heartbeats.get(channelId);

    manager.start();
    const secondInterval = heartbeats.get(channelId);

    // Should have replaced the interval
    expect(secondInterval).not.toBe(firstInterval);

    // Cleanup
    manager.stop();
  });
});
