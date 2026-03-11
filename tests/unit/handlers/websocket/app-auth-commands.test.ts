/**
 * Tests for App Auth Commands
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createAppAuthCommands } from '../../../../packages/backend/src/handlers/websocket/app-auth-commands';

describe('AppAuthCommands', () => {
  let mcaServiceMock: any;
  let mcaOAuthMock: any;
  let sendMessageMock: ReturnType<typeof mock>;
  let sendErrorMock: ReturnType<typeof mock>;
  let wsMock: any;

  const userId = 'user_test123';
  const appId = 'app_test456';

  beforeEach(() => {
    mcaServiceMock = {
      getApp: mock(() =>
        Promise.resolve({
          appId,
          mcpId: 'mca.test',
          name: 'Test App',
        }),
      ),
      getMcaFromCatalog: mock(() =>
        Promise.resolve({
          mcpId: 'mca.test',
          name: 'Test MCA',
        }),
      ),
    };

    mcaOAuthMock = {
      getAuthStatus: mock(() =>
        Promise.resolve({
          status: 'ready',
          authType: 'oauth',
        }),
      ),
      saveApiKeyCredentials: mock(() => Promise.resolve()),
      disconnect: mock(() => Promise.resolve()),
    };

    sendMessageMock = mock(() => {});
    sendErrorMock = mock(() => {});

    wsMock = {
      readyState: 1,
      send: mock(() => {}),
    };
  });

  const createCommands = (oauth = mcaOAuthMock) =>
    createAppAuthCommands({
      mcaService: mcaServiceMock,
      mcaOAuth: oauth,
      sendMessage: sendMessageMock,
      sendError: sendErrorMock,
    });

  describe('handleGetAppAuthStatus', () => {
    it('should return auth status for app', async () => {
      const commands = createCommands();
      await commands.handleGetAppAuthStatus(wsMock, userId, { appId });

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('app_auth_status');
      expect(response.appId).toBe(appId);
      expect(response.auth.status).toBe('ready');
    });

    it('should require appId', async () => {
      const commands = createCommands();
      await commands.handleGetAppAuthStatus(wsMock, userId, { appId: '' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'MISSING_APP_ID', 'appId is required');
    });

    it('should return error if mcaOAuth not configured', async () => {
      const commands = createCommands(null);
      await commands.handleGetAppAuthStatus(wsMock, userId, { appId });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'AUTH_NOT_CONFIGURED',
        'MCA OAuth not configured',
      );
    });

    it('should return error if app not found', async () => {
      mcaServiceMock.getApp = mock(() => Promise.resolve(null));

      const commands = createCommands();
      await commands.handleGetAppAuthStatus(wsMock, userId, { appId });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'APP_NOT_FOUND', `App ${appId} not found`);
    });

    it('should return error if MCA not found', async () => {
      mcaServiceMock.getMcaFromCatalog = mock(() => Promise.resolve(null));

      const commands = createCommands();
      await commands.handleGetAppAuthStatus(wsMock, userId, { appId });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'MCA_NOT_FOUND', 'MCA mca.test not found');
    });
  });

  describe('handleConfigureAppCredentials', () => {
    it('should save API key credentials', async () => {
      const credentials = { apiKey: 'test-key-123' };

      const commands = createCommands();
      await commands.handleConfigureAppCredentials(wsMock, userId, { appId, credentials });

      expect(mcaOAuthMock.saveApiKeyCredentials).toHaveBeenCalledWith(
        userId,
        appId,
        'mca.test',
        credentials,
      );

      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('app_credentials_configured');
      expect(response.success).toBe(true);
    });

    it('should require appId', async () => {
      const commands = createCommands();
      await commands.handleConfigureAppCredentials(wsMock, userId, {
        appId: '',
        credentials: { key: 'value' },
      });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'MISSING_APP_ID', 'appId is required');
    });

    it('should require credentials', async () => {
      const commands = createCommands();
      await commands.handleConfigureAppCredentials(wsMock, userId, {
        appId,
        credentials: {},
      });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'MISSING_CREDENTIALS',
        'credentials are required',
      );
    });

    it('should return error if mcaOAuth not configured', async () => {
      const commands = createCommands(null);
      await commands.handleConfigureAppCredentials(wsMock, userId, {
        appId,
        credentials: { key: 'value' },
      });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'AUTH_NOT_CONFIGURED',
        'MCA OAuth not configured',
      );
    });

    it('should return error if app not found', async () => {
      mcaServiceMock.getApp = mock(() => Promise.resolve(null));

      const commands = createCommands();
      await commands.handleConfigureAppCredentials(wsMock, userId, {
        appId,
        credentials: { key: 'value' },
      });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'APP_NOT_FOUND', `App ${appId} not found`);
    });
  });

  describe('handleDisconnectAppAuth', () => {
    it('should disconnect app auth', async () => {
      const commands = createCommands();
      await commands.handleDisconnectAppAuth(wsMock, userId, { appId });

      expect(mcaOAuthMock.disconnect).toHaveBeenCalledWith(userId, appId);

      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('app_auth_disconnected');
      expect(response.success).toBe(true);
    });

    it('should require appId', async () => {
      const commands = createCommands();
      await commands.handleDisconnectAppAuth(wsMock, userId, { appId: '' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'MISSING_APP_ID', 'appId is required');
    });

    it('should return error if mcaOAuth not configured', async () => {
      const commands = createCommands(null);
      await commands.handleDisconnectAppAuth(wsMock, userId, { appId });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'AUTH_NOT_CONFIGURED',
        'MCA OAuth not configured',
      );
    });

    it('should return updated auth status after disconnect', async () => {
      mcaOAuthMock.getAuthStatus = mock(() =>
        Promise.resolve({
          status: 'needs_user_auth',
          authType: 'oauth',
        }),
      );

      const commands = createCommands();
      await commands.handleDisconnectAppAuth(wsMock, userId, { appId });

      const response = sendMessageMock.mock.calls[0][1];
      expect(response.auth.status).toBe('needs_user_auth');
    });

    it('should handle errors gracefully', async () => {
      mcaOAuthMock.disconnect = mock(() => Promise.reject(new Error('Disconnect failed')));

      const commands = createCommands();
      await commands.handleDisconnectAppAuth(wsMock, userId, { appId });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'DISCONNECT_AUTH_ERROR',
        'Failed to disconnect auth',
      );
    });
  });
});
