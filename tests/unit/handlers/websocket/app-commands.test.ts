/**
 * Tests for App Commands
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createAppCommands } from '../../../../packages/backend/src/handlers/websocket/app-commands';

describe('AppCommands', () => {
  let mcaServiceMock: any;
  let sendMessageMock: ReturnType<typeof mock>;
  let sendErrorMock: ReturnType<typeof mock>;
  let wsMock: any;

  const userId = 'user_test123';

  beforeEach(() => {
    mcaServiceMock = {
      listAppsByOwner: mock(() => Promise.resolve([])),
      getMcaFromCatalog: mock(() => Promise.resolve(null)),
      createApp: mock(() =>
        Promise.resolve({
          appId: 'app_new',
          mcpId: 'mca.test',
          name: 'Test App',
          status: 'active',
        }),
      ),
      deleteApp: mock(() => Promise.resolve({ success: true })),
      renameApp: mock(() => Promise.resolve({ success: true })),
      validateAppName: mock(() => ({ valid: true })),
      isAppNameAvailable: mock(() => Promise.resolve(true)),
      generateDefaultAppName: mock(() => Promise.resolve('test-app')),
    };

    sendMessageMock = mock(() => {});
    sendErrorMock = mock(() => {});

    wsMock = {
      readyState: 1, // OPEN
      send: mock(() => {}),
    };
  });

  const createCommands = () =>
    createAppCommands({
      mcaService: mcaServiceMock,
      sendMessage: sendMessageMock,
      sendError: sendErrorMock,
    });

  describe('handleListApps', () => {
    it('should list user apps and system apps', async () => {
      const userApps = [{ appId: 'app_1', mcpId: 'mca.test1', name: 'User App', status: 'active' }];
      const systemApps = [
        { appId: 'app_sys', mcpId: 'mca.system', name: 'System App', status: 'active' },
      ];

      mcaServiceMock.listAppsByOwner = mock((owner: string) =>
        Promise.resolve(owner === userId ? userApps : systemApps),
      );
      mcaServiceMock.getMcaFromCatalog = mock(() =>
        Promise.resolve({
          name: 'Test MCA',
          description: 'Test description',
          icon: '🔧',
          category: 'tools',
        }),
      );

      const commands = createCommands();
      await commands.handleListApps(wsMock, userId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const call = sendMessageMock.mock.calls[0];
      expect(call[1].type).toBe('apps_list');
      expect(call[1].apps.length).toBe(2);
    });

    it('should handle errors gracefully', async () => {
      mcaServiceMock.listAppsByOwner = mock(() => Promise.reject(new Error('DB error')));

      const commands = createCommands();
      await commands.handleListApps(wsMock, userId);

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'LIST_APPS_ERROR', 'Failed to list apps');
    });
  });

  describe('handleInstallApp', () => {
    it('should install app from catalog', async () => {
      mcaServiceMock.getMcaFromCatalog = mock(() =>
        Promise.resolve({
          mcpId: 'mca.test',
          name: 'Test MCA',
          description: 'Test',
          availability: { enabled: true },
        }),
      );

      const commands = createCommands();
      await commands.handleInstallApp(wsMock, userId, { mcpId: 'mca.test' });

      expect(mcaServiceMock.createApp).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock.mock.calls[0][1].type).toBe('app_installed');
    });

    it('should reject if MCA not found', async () => {
      mcaServiceMock.getMcaFromCatalog = mock(() => Promise.resolve(null));

      const commands = createCommands();
      await commands.handleInstallApp(wsMock, userId, { mcpId: 'mca.nonexistent' });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'MCA_NOT_FOUND',
        'MCA mca.nonexistent not found in catalog',
      );
    });

    it('should reject if MCA is disabled', async () => {
      mcaServiceMock.getMcaFromCatalog = mock(() =>
        Promise.resolve({
          mcpId: 'mca.test',
          availability: { enabled: false },
        }),
      );

      const commands = createCommands();
      await commands.handleInstallApp(wsMock, userId, { mcpId: 'mca.test' });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'MCA_DISABLED',
        'MCA mca.test is not available',
      );
    });

    it('should validate custom app name', async () => {
      mcaServiceMock.getMcaFromCatalog = mock(() =>
        Promise.resolve({
          mcpId: 'mca.test',
          availability: { enabled: true },
        }),
      );
      mcaServiceMock.validateAppName = mock(() => ({ valid: false, error: 'Name too short' }));

      const commands = createCommands();
      await commands.handleInstallApp(wsMock, userId, { mcpId: 'mca.test', name: 'ab' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'INVALID_APP_NAME', 'Name too short');
    });
  });

  describe('handleUninstallApp', () => {
    it('should uninstall app', async () => {
      const commands = createCommands();
      await commands.handleUninstallApp(wsMock, userId, { appId: 'app_123' });

      expect(mcaServiceMock.deleteApp).toHaveBeenCalledWith('app_123', userId);
      expect(sendMessageMock.mock.calls[0][1].type).toBe('app_uninstalled');
    });

    it('should require appId', async () => {
      const commands = createCommands();
      await commands.handleUninstallApp(wsMock, userId, { appId: '' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'MISSING_APP_ID', 'appId is required');
    });

    it('should handle deletion failure', async () => {
      mcaServiceMock.deleteApp = mock(() =>
        Promise.resolve({ success: false, error: 'Not found' }),
      );

      const commands = createCommands();
      await commands.handleUninstallApp(wsMock, userId, { appId: 'app_123' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'UNINSTALL_APP_ERROR', 'Not found');
    });
  });

  describe('handleRenameApp', () => {
    it('should rename app', async () => {
      const commands = createCommands();
      await commands.handleRenameApp(wsMock, userId, { appId: 'app_123', name: 'New Name' });

      expect(mcaServiceMock.renameApp).toHaveBeenCalledWith('app_123', userId, 'New Name');
      expect(sendMessageMock.mock.calls[0][1].type).toBe('app_renamed');
    });

    it('should require appId and name', async () => {
      const commands = createCommands();

      await commands.handleRenameApp(wsMock, userId, { appId: '', name: 'Test' });
      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'MISSING_APP_ID', 'appId is required');

      sendErrorMock.mockClear();

      await commands.handleRenameApp(wsMock, userId, { appId: 'app_123', name: '' });
      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'MISSING_NAME', 'name is required');
    });
  });
});
