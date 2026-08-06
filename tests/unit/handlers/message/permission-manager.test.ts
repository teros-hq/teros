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
    // BUG: pendingPermissions is a module-level Map (not per-instance), so tests
    // contaminate each other if pending requests are not cleared. clearAll() flushes
    // the global state before each test. This should be fixed in the source by moving
    // the Map inside the factory function.
    manager.clearAll();
  });

  describe('createAskPermissionCallback', () => {
    it('should broadcast permission request to channel', async () => {
      const callback = manager.createAskPermissionCallback(channelId);

      // Start the permission request (don't await yet)
      const promise = callback('test_tool', 'app_123', { key: 'value' });

      // Should have broadcast the permission request.
      // NOTE: The handler also calls broadcastToChannel with a 'channel_status' message
      // (via notifyExternalActionChange), so there are 2 calls total, not 1.
      // We find the tool_permission_request call explicitly.
      const permCall = broadcastMock.mock.calls.find((c: any[]) => c[1]?.type === 'tool_permission_request');
      expect(permCall).toBeDefined();
      expect(permCall![0]).toBe(channelId);
      expect(permCall![1].type).toBe('tool_permission_request');
      expect(permCall![1].toolName).toBe('test_tool');
      expect(permCall![1].appId).toBe('app_123');
      expect(permCall![1].input).toEqual({ key: 'value' });
      expect(permCall![1].requestId).toMatch(/^perm_[0-9a-f-]+$/);

      // Resolve the promise to avoid timeout
      const requestId = permCall![1].requestId;
      manager.handleResponse(requestId, true);

      const result = await promise;
      expect(result).toBe('granted');
    });

    it('should resolve with true when granted', async () => {
      const callback = manager.createAskPermissionCallback(channelId);

      const promise = callback('test_tool', 'app_123', {});
      const permCall = broadcastMock.mock.calls.find((c: any[]) => c[1]?.type === 'tool_permission_request');
      const requestId = permCall![1].requestId;

      manager.handleResponse(requestId, true);

      const result = await promise;
      expect(result).toBe('granted');
    });

    it('should resolve with false when denied', async () => {
      const callback = manager.createAskPermissionCallback(channelId);

      const promise = callback('test_tool', 'app_123', {});
      const permCall = broadcastMock.mock.calls.find((c: any[]) => c[1]?.type === 'tool_permission_request');
      const requestId = permCall![1].requestId;

      manager.handleResponse(requestId, false);

      const result = await promise;
      expect(result).toBe('denied');
    });

    it('should auto-forbid when getToolCallContext returns null (no messageId to link)', async () => {
      const callback = manager.createAskPermissionCallback(
        channelId,
        'user_test',
        () => null, // simulates: tool call not tracked in streamState
      );

      const result = await callback('test_tool', 'app_123', {});
      expect(result).toBe('denied');

      // Should NOT have broadcast a permission request — denied immediately
      const permCall = broadcastMock.mock.calls.find((c: any[]) => c[1]?.type === 'tool_permission_request');
      expect(permCall).toBeUndefined();
    });

    it('should auto-forbid when getToolCallContext returns a context without messageId', async () => {
      const callback = manager.createAskPermissionCallback(
        channelId,
        'user_test',
        () => ({ toolCallId: 'call_abc123' }), // TER-267 case: toolCallId known, messageId missing
      );

      const result = await callback('test_tool', 'app_123', {});
      expect(result).toBe('denied');

      // Should NOT have broadcast a permission request — denied immediately
      const permCall = broadcastMock.mock.calls.find((c: any[]) => c[1]?.type === 'tool_permission_request');
      expect(permCall).toBeUndefined();
    });

    it('should allow permission request when getToolCallContext returns valid context', async () => {
      const callback = manager.createAskPermissionCallback(
        channelId,
        'user_test',
        () => ({ messageId: 'msg_123', toolCallId: 'call_abc123' }),
      );

      const promise = callback('test_tool', 'app_123', {});
      const permCall = broadcastMock.mock.calls.find((c: any[]) => c[1]?.type === 'tool_permission_request');
      expect(permCall).toBeDefined();
      expect(permCall![1].messageId).toBe('msg_123');
      expect(permCall![1].toolCallId).toBe('call_abc123');

      const requestId = permCall![1].requestId;
      manager.handleResponse(requestId, true);

      const result = await promise;
      expect(result).toBe('granted');
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

      const permCall = broadcastMock.mock.calls.find((c: any[]) => c[1]?.type === 'tool_permission_request');
      const requestId = permCall![1].requestId;
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
      expect(result1).toBe('denied');
      expect(result2).toBe('denied');
      expect(manager.getPendingCount()).toBe(0);
    });
  });

  // bug tracker
  // @todo alice - 2026-04-02: fix bug — move pendingPermissions inside createPermissionManager so each factory instance gets its own Map, eliminating cross-test contamination
  it.todo('bug: pendingPermissions is module-level, causes cross-test contamination — should be local to factory (createPermissionManager)');
});
