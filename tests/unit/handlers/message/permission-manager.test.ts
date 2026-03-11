/**
 * Tests for PermissionManager
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createPermissionManager } from '../../../../packages/backend/src/handlers/message/permission-manager';

describe('PermissionManager', () => {
  let broadcastMock: ReturnType<typeof mock>;
  let manager: ReturnType<typeof createPermissionManager>;

  const channelId = 'ch_test123';

  beforeEach(() => {
    broadcastMock = mock(() => {});
    manager = createPermissionManager({
      broadcastToChannel: broadcastMock,
    });
  });

  describe('createAskPermissionCallback', () => {
    it('should broadcast permission request to channel', async () => {
      const callback = manager.createAskPermissionCallback(channelId);

      // Start the permission request (don't await yet)
      const promise = callback('test_tool', 'app_123', { key: 'value' });

      // Should have broadcast the request
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      const call = broadcastMock.mock.calls[0];
      expect(call[0]).toBe(channelId);
      expect(call[1].type).toBe('tool_permission_request');
      expect(call[1].toolName).toBe('test_tool');
      expect(call[1].appId).toBe('app_123');
      expect(call[1].input).toEqual({ key: 'value' });
      expect(call[1].requestId).toMatch(/^perm_\d+_\d+$/);

      // Resolve the promise to avoid timeout
      const requestId = call[1].requestId;
      manager.handleResponse(requestId, true);

      const result = await promise;
      expect(result).toBe(true);
    });

    it('should resolve with true when granted', async () => {
      const callback = manager.createAskPermissionCallback(channelId);

      const promise = callback('test_tool', 'app_123', {});
      const requestId = broadcastMock.mock.calls[0][1].requestId;

      manager.handleResponse(requestId, true);

      const result = await promise;
      expect(result).toBe(true);
    });

    it('should resolve with false when denied', async () => {
      const callback = manager.createAskPermissionCallback(channelId);

      const promise = callback('test_tool', 'app_123', {});
      const requestId = broadcastMock.mock.calls[0][1].requestId;

      manager.handleResponse(requestId, false);

      const result = await promise;
      expect(result).toBe(false);
    });
  });

  describe('handleResponse', () => {
    it('should ignore unknown request IDs', () => {
      // Should not throw
      manager.handleResponse('unknown_request_id', true);
      expect(manager.getPendingCount()).toBe(0);
    });

    it('should remove request from pending after handling', async () => {
      const callback = manager.createAskPermissionCallback(channelId);

      const promise = callback('test_tool', 'app_123', {});
      expect(manager.getPendingCount()).toBe(1);

      const requestId = broadcastMock.mock.calls[0][1].requestId;
      manager.handleResponse(requestId, true);

      await promise;
      expect(manager.getPendingCount()).toBe(0);
    });
  });

  describe('clearAll', () => {
    it('should resolve all pending requests with false', async () => {
      const callback = manager.createAskPermissionCallback(channelId);

      const promise1 = callback('tool1', 'app_1', {});
      const promise2 = callback('tool2', 'app_2', {});

      expect(manager.getPendingCount()).toBe(2);

      manager.clearAll();

      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).toBe(false);
      expect(result2).toBe(false);
      expect(manager.getPendingCount()).toBe(0);
    });
  });
});
