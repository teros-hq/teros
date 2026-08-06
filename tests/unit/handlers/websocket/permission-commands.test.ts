/**
 * Tests for Permission Commands
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createPermissionCommands } from '../../../../packages/backend/src/handlers/websocket/permission-commands';

describe('PermissionCommands', () => {
  let mcaServiceMock: any;
  let sendMessageMock: ReturnType<typeof mock>;
  let sendErrorMock: ReturnType<typeof mock>;
  let handlePermissionResponseMock: ReturnType<typeof mock>;
  let wsMock: any;

  const userId = 'user_test123';
  const appId = 'app_test456';
  const agentId = 'agent_test789';

  beforeEach(() => {
    mcaServiceMock = {
      getApp: mock(() =>
        Promise.resolve({
          appId,
          mcaId: 'mca.test',
          ownerId: userId,
          name: 'Test App',
        }),
      ),
      getMcaFromCatalog: mock(() =>
        Promise.resolve({
          mcaId: 'mca.test',
          name: 'Test MCA',
          tools: ['tool1', 'tool2', 'tool3'],
        }),
      ),
      // updateAppPermissions: used by handleUpdateAppPermissions (deprecated handler)
      updateAppPermissions: mock(() =>
        Promise.resolve({
          permissions: { defaultPermission: 'allow', tools: {} },
        }),
      ),
      // updateToolPermission: used by handleUpdateToolPermission
      updateToolPermission: mock(() =>
        Promise.resolve({
          appId,
          permissions: { defaultPermission: 'ask', tools: { tool1: 'allow' } },
        }),
      ),
    };

    sendMessageMock = mock(() => {});
    sendErrorMock = mock(() => {});
    handlePermissionResponseMock = mock(() => {});

    wsMock = {
      readyState: 1,
      send: mock(() => {}),
    };
  });

  const createCommands = () =>
    createPermissionCommands({
      mcaService: mcaServiceMock,
      sendMessage: sendMessageMock,
      sendError: sendErrorMock,
      handlePermissionResponse: handlePermissionResponseMock,
    });

  describe('handleToolPermissionResponse', () => {
    it('should delegate to handlePermissionResponse callback', () => {
      const commands = createCommands();
      commands.handleToolPermissionResponse({ requestId: 'req_123', granted: true });

      expect(handlePermissionResponseMock).toHaveBeenCalledWith('req_123', true);
    });

    it('should warn if requestId is missing', () => {
      const commands = createCommands();
      // Should not throw
      commands.handleToolPermissionResponse({ requestId: '', granted: true });

      expect(handlePermissionResponseMock).not.toHaveBeenCalled();
    });
  });

  describe('handleGetAppTools', () => {
    it('should return tools with permissions', async () => {
      const commands = createCommands();
      await commands.handleGetAppTools(wsMock, userId, { appId });

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('app_tools');
      expect(response.appId).toBe(appId);
      expect(response.tools.length).toBe(3);
      expect(response.tools[0].name).toBe('tool1');
    });

    it('should require appId', async () => {
      const commands = createCommands();
      await commands.handleGetAppTools(wsMock, userId, { appId: '' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'MISSING_APP_ID', 'appId is required');
    });

    it('should return error if app not found', async () => {
      mcaServiceMock.getApp = mock(() => Promise.resolve(null));

      const commands = createCommands();
      await commands.handleGetAppTools(wsMock, userId, { appId });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'APP_NOT_FOUND', 'App not found');
    });

    it('should deny access if user is not owner', async () => {
      mcaServiceMock.getApp = mock(() =>
        Promise.resolve({
          appId,
          ownerId: 'other_user',
        }),
      );

      const commands = createCommands();
      await commands.handleGetAppTools(wsMock, userId, { appId });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'ACCESS_DENIED', 'Access denied');
    });

    it('should allow access to system apps', async () => {
      mcaServiceMock.getApp = mock(() =>
        Promise.resolve({
          appId,
          ownerId: 'system',
          mcaId: 'mca.test',
        }),
      );

      const commands = createCommands();
      await commands.handleGetAppTools(wsMock, userId, { appId });

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleUpdateAppPermissions', () => {
    it('should update all permissions', async () => {
      const commands = createCommands();
      await commands.handleUpdateAppPermissions(wsMock, userId, {
        appId,
        permissions: { defaultPermission: 'allow', tools: {} },
      });

      expect(mcaServiceMock.updateAppPermissions).toHaveBeenCalled();
      expect(sendMessageMock.mock.calls[0][1].type).toBe('app_permissions_updated');
    });

    it('should require appId and permissions', async () => {
      const commands = createCommands();

      await commands.handleUpdateAppPermissions(wsMock, userId, {
        appId: '',
        permissions: { defaultPermission: 'allow' },
      });
      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'MISSING_PARAMS',
        'appId and permissions are required',
      );
    });

    it('should validate defaultPermission', async () => {
      const commands = createCommands();
      await commands.handleUpdateAppPermissions(wsMock, userId, {
        appId,
        permissions: { defaultPermission: 'invalid' as any },
      });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'INVALID_PERMISSIONS',
        'Invalid defaultPermission',
      );
    });

    it('should return error if update fails', async () => {
      // NOTE: The handler calls mcaService.updateAppPermissions (not updatePermissions).
      // When it returns null, the handler sends UPDATE_PERMISSIONS_ERROR.
      // The old test expected UPDATE_FAILED/'Agent access not found' — that was the old API.
      mcaServiceMock.updateAppPermissions = mock(() => Promise.resolve(null));

      const commands = createCommands();
      await commands.handleUpdateAppPermissions(wsMock, userId, {
        appId,
        permissions: { defaultPermission: 'allow' },
      });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'UPDATE_FAILED',
        'Failed to update permissions',
      );
    });
  });

  describe('handleUpdateToolPermission', () => {
    it('should update single tool permission', async () => {
      const commands = createCommands();
      await commands.handleUpdateToolPermission(wsMock, userId, {
        appId,
        toolName: 'tool1',
        permission: 'allow',
      });

      expect(sendMessageMock.mock.calls[0][1].type).toBe('tool_permission_updated');
      expect(sendMessageMock.mock.calls[0][1].toolName).toBe('tool1');
      expect(sendMessageMock.mock.calls[0][1].permission).toBe('allow');
    });

    it('should require all parameters', async () => {
      const commands = createCommands();

      await commands.handleUpdateToolPermission(wsMock, userId, {
        appId: '',
        toolName: 'tool1',
        permission: 'allow',
      });
      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'MISSING_PARAMS',
        'appId, toolName, and permission are required',
      );
    });

    it('should validate permission value', async () => {
      const commands = createCommands();
      await commands.handleUpdateToolPermission(wsMock, userId, {
        appId,
        toolName: 'tool1',
        permission: 'invalid' as any,
      });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'INVALID_PERMISSION',
        'Permission must be: allow, ask, or forbid',
      );
    });

    it('should return error if tool not found in MCA', async () => {
      // The handler extracts shortToolName via split('_').slice(1).join('_'):
      //   'prefix_nonexistent' → shortToolName = 'nonexistent'
      //   'nonexistent' (no underscore) → shortToolName = 'nonexistent'
      // Use a toolName without underscore so shortToolName equals the full name.
      const commands = createCommands();
      await commands.handleUpdateToolPermission(wsMock, userId, {
        appId,
        toolName: 'nonexistent',
        permission: 'allow',
      });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'TOOL_NOT_FOUND',
        "Tool 'nonexistent' not found in this app",
      );
    });

    it('should return error if update fails (updateToolPermission returns null)', async () => {
      // NOTE: The old test checked for ACCESS_NOT_FOUND via getAccess — that API no longer exists.
      // The handler now uses canManageApp (ownership check). When updateToolPermission returns
      // null, the handler sends UPDATE_FAILED.
      mcaServiceMock.updateToolPermission = mock(() => Promise.resolve(null));

      const commands = createCommands();
      await commands.handleUpdateToolPermission(wsMock, userId, {
        appId,
        toolName: 'tool1',
        permission: 'allow',
      });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'UPDATE_FAILED',
        'Failed to update permission',
      );
    });
  });
});
