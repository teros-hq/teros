import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubscriptionManager } from '../../src/ws-framework/SubscriptionManager';

function createMockWs() {
  const sent: string[] = [];
  return {
    send: vi.fn((data: string) => { sent.push(data); }),
    sent,
    lastMessage(): any {
      return JSON.parse(sent[sent.length - 1]);
    },
    allMessages(): any[] {
      return sent.map((s) => JSON.parse(s));
    },
  } as any;
}

describe('SubscriptionManager', () => {
  let mgr: SubscriptionManager;

  beforeEach(() => {
    mgr = new SubscriptionManager();
  });

  // ==========================================================================
  // SUBSCRIBE / UNSUBSCRIBE
  // ==========================================================================

  describe('subscribe', () => {
    it('should track a subscription', () => {
      const ws = createMockWs();
      mgr.subscribe(ws, 'board:proj_1');

      expect(mgr.subscriberCount('board:proj_1')).toBe(1);
      expect(mgr.getChannels(ws)).toEqual(['board:proj_1']);
    });

    it('should allow multiple connections on the same channel', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      mgr.subscribe(ws1, 'board:proj_1');
      mgr.subscribe(ws2, 'board:proj_1');

      expect(mgr.subscriberCount('board:proj_1')).toBe(2);
    });

    it('should allow one connection to subscribe to multiple channels', () => {
      const ws = createMockWs();

      mgr.subscribe(ws, 'board:proj_1');
      mgr.subscribe(ws, 'channel:ch_1');

      expect(mgr.getChannels(ws)).toEqual(
        expect.arrayContaining(['board:proj_1', 'channel:ch_1']),
      );
    });

    it('should not duplicate if subscribing twice to the same channel', () => {
      const ws = createMockWs();

      mgr.subscribe(ws, 'board:proj_1');
      mgr.subscribe(ws, 'board:proj_1');

      expect(mgr.subscriberCount('board:proj_1')).toBe(1);
      expect(mgr.getChannels(ws)).toHaveLength(1);
    });
  });

  describe('unsubscribe', () => {
    it('should remove a subscription', () => {
      const ws = createMockWs();
      mgr.subscribe(ws, 'board:proj_1');
      mgr.unsubscribe(ws, 'board:proj_1');

      expect(mgr.subscriberCount('board:proj_1')).toBe(0);
      expect(mgr.getChannels(ws)).toEqual([]);
    });

    it('should be safe to unsubscribe from a channel not subscribed to', () => {
      const ws = createMockWs();
      // Should not throw
      mgr.unsubscribe(ws, 'nonexistent:channel');
      expect(mgr.subscriberCount('nonexistent:channel')).toBe(0);
    });

    it('should only remove the specific connection, not others', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      mgr.subscribe(ws1, 'board:proj_1');
      mgr.subscribe(ws2, 'board:proj_1');
      mgr.unsubscribe(ws1, 'board:proj_1');

      expect(mgr.subscriberCount('board:proj_1')).toBe(1);
      expect(mgr.getChannels(ws1)).toEqual([]);
      expect(mgr.getChannels(ws2)).toEqual(['board:proj_1']);
    });
  });

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  describe('cleanup', () => {
    it('should remove a connection from all its subscriptions', () => {
      const ws = createMockWs();

      mgr.subscribe(ws, 'board:proj_1');
      mgr.subscribe(ws, 'channel:ch_1');
      mgr.subscribe(ws, 'channel:ch_2');

      mgr.cleanup(ws);

      expect(mgr.subscriberCount('board:proj_1')).toBe(0);
      expect(mgr.subscriberCount('channel:ch_1')).toBe(0);
      expect(mgr.subscriberCount('channel:ch_2')).toBe(0);
      expect(mgr.getChannels(ws)).toEqual([]);
    });

    it('should not affect other connections when cleaning up one', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      mgr.subscribe(ws1, 'board:proj_1');
      mgr.subscribe(ws2, 'board:proj_1');
      mgr.subscribe(ws2, 'channel:ch_1');

      mgr.cleanup(ws1);

      expect(mgr.subscriberCount('board:proj_1')).toBe(1);
      expect(mgr.subscriberCount('channel:ch_1')).toBe(1);
      expect(mgr.getChannels(ws2)).toHaveLength(2);
    });

    it('should be safe to cleanup a connection with no subscriptions', () => {
      const ws = createMockWs();
      // Should not throw
      mgr.cleanup(ws);
      expect(mgr.getChannels(ws)).toEqual([]);
    });
  });

  // ==========================================================================
  // PUBLISH
  // ==========================================================================

  describe('publish', () => {
    it('should send an event to all subscribers of a channel', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      mgr.subscribe(ws1, 'board:proj_1');
      mgr.subscribe(ws2, 'board:proj_1');

      mgr.publish('board:proj_1', 'task.created', { taskId: 'task_1' });

      for (const ws of [ws1, ws2]) {
        expect(ws.send).toHaveBeenCalledTimes(1);
        const msg = ws.lastMessage();
        expect(msg.type).toBe('event');
        expect(msg.event).toBe('task.created');
        expect(msg.channel).toBe('board:proj_1');
        expect(msg.data).toEqual({ taskId: 'task_1' });
      }
    });

    it('should not send to connections on other channels', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      mgr.subscribe(ws1, 'board:proj_1');
      mgr.subscribe(ws2, 'board:proj_2');

      mgr.publish('board:proj_1', 'task.created', { taskId: 'task_1' });

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(0);
    });

    it('should not throw when publishing to a channel with no subscribers', () => {
      // Should not throw
      mgr.publish('empty:channel', 'some.event', {});
    });

    it('should handle a dead connection gracefully (send throws)', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      // ws1 is "dead"
      ws1.send = vi.fn(() => { throw new Error('Connection closed'); });

      mgr.subscribe(ws1, 'board:proj_1');
      mgr.subscribe(ws2, 'board:proj_1');

      // Should not throw, and ws2 should still get the message
      mgr.publish('board:proj_1', 'task.created', { taskId: 'task_1' });

      expect(ws2.send).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle subscribe → publish → unsubscribe → publish correctly', () => {
      const ws = createMockWs();

      mgr.subscribe(ws, 'board:proj_1');
      mgr.publish('board:proj_1', 'event1', {});
      expect(ws.send).toHaveBeenCalledTimes(1);

      mgr.unsubscribe(ws, 'board:proj_1');
      mgr.publish('board:proj_1', 'event2', {});
      // Should still be 1 — no new message after unsubscribe
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it('should handle subscribe → cleanup → publish correctly', () => {
      const ws = createMockWs();

      mgr.subscribe(ws, 'board:proj_1');
      mgr.cleanup(ws);
      mgr.publish('board:proj_1', 'event', {});

      expect(ws.send).toHaveBeenCalledTimes(0);
    });
  });
});
