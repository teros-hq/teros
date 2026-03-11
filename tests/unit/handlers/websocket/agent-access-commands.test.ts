/**
 * Tests for Agent Access Commands
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createAgentAccessCommands } from '../../../../packages/backend/src/handlers/websocket/agent-access-commands';

describe('AgentAccessCommands', () => {
  let mcaServiceMock: any;
  let sendMessageMock: ReturnType<typeof mock>;
  let sendErrorMock: ReturnType<typeof mock>;
  let wsMock: any;

  const userId = 'user_test123';
  const agentId = 'agent_test456';
  const appId = 'app_test789';

  beforeEach(() => {
    mcaServiceMock = {
      getAgentApps: mock(() => Promise.resolve({ apps: [] })),
      grantAccess: mock(() => Promise.resolve()),
      revokeAccess: mock(() => Promise.resolve(true)),
    };

    sendMessageMock = mock(() => {});
    sendErrorMock = mock(() => {});

    wsMock = {
      readyState: 1,
      send: mock(() => {}),
    };
  });

  const createCommands = () =>
    createAgentAccessCommands({
      mcaService: mcaServiceMock,
      sendMessage: sendMessageMock,
      sendError: sendErrorMock,
    });

  describe('handleGetAgentApps', () => {
    it('should return agent apps with details', async () => {
      mcaServiceMock.getAgentApps = mock(() =>
        Promise.resolve({
          apps: [
            {
              app: {
                appId: 'app_1',
                name: 'Test App',
                mcp: {
                  mcpId: 'mca.test',
                  description: 'Test MCA',
                  icon: '🔧',
                },
              },
              access: {
                grantedAt: new Date().toISOString(),
              },
            },
          ],
        }),
      );

      const commands = createCommands();
      await commands.handleGetAgentApps(wsMock, { agentId });

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('agent_apps');
      expect(response.agentId).toBe(agentId);
      expect(response.apps.length).toBe(1);
      expect(response.apps[0].hasAccess).toBe(true);
    });

    it('should return empty array when no apps', async () => {
      const commands = createCommands();
      await commands.handleGetAgentApps(wsMock, { agentId });

      const response = sendMessageMock.mock.calls[0][1];
      expect(response.apps).toEqual([]);
    });

    it('should handle errors gracefully', async () => {
      mcaServiceMock.getAgentApps = mock(() => Promise.reject(new Error('DB error')));

      const commands = createCommands();
      await commands.handleGetAgentApps(wsMock, { agentId });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'GET_AGENT_APPS_ERROR',
        'Failed to get agent apps',
      );
    });
  });

  describe('handleGrantAppAccess', () => {
    it('should grant access to app', async () => {
      const commands = createCommands();
      await commands.handleGrantAppAccess(wsMock, userId, { agentId, appId });

      expect(mcaServiceMock.grantAccess).toHaveBeenCalledWith({
        agentId,
        appId,
        grantedBy: userId,
      });

      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('app_access_granted');
      expect(response.success).toBe(true);
    });

    it('should handle grant errors', async () => {
      mcaServiceMock.grantAccess = mock(() => Promise.reject(new Error('Access denied')));

      const commands = createCommands();
      await commands.handleGrantAppAccess(wsMock, userId, { agentId, appId });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'GRANT_ACCESS_ERROR',
        'Failed to grant app access',
      );
    });
  });

  describe('handleRevokeAppAccess', () => {
    it('should revoke access to app', async () => {
      const commands = createCommands();
      await commands.handleRevokeAppAccess(wsMock, userId, { agentId, appId });

      expect(mcaServiceMock.revokeAccess).toHaveBeenCalledWith(agentId, appId);

      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('app_access_revoked');
      expect(response.success).toBe(true);
    });

    it('should return false when revoke fails', async () => {
      mcaServiceMock.revokeAccess = mock(() => Promise.resolve(false));

      const commands = createCommands();
      await commands.handleRevokeAppAccess(wsMock, userId, { agentId, appId });

      const response = sendMessageMock.mock.calls[0][1];
      expect(response.success).toBe(false);
    });

    it('should handle revoke errors', async () => {
      mcaServiceMock.revokeAccess = mock(() => Promise.reject(new Error('Error')));

      const commands = createCommands();
      await commands.handleRevokeAppAccess(wsMock, userId, { agentId, appId });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'REVOKE_ACCESS_ERROR',
        'Failed to revoke app access',
      );
    });
  });
});
