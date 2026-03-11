/**
 * Tests demonstrating interface usage for mocking
 *
 * These tests show how to use the service interfaces for dependency injection
 * and mocking in unit tests.
 */
import { describe, expect, it, mock } from 'bun:test';
import type {
  IChannelManager,
  IMcaService,
  IModelService,
} from '../../../packages/backend/src/services/interfaces';

describe('Service Interfaces', () => {
  describe('IMcaService mock', () => {
    it('should be mockable for testing app commands', async () => {
      // Create a mock that implements IMcaService
      const mockMcaService: Partial<IMcaService> = {
        listAppsByOwner: mock(() =>
          Promise.resolve([
            {
              appId: 'app_1',
              mcpId: 'mca.test',
              name: 'Test App',
              ownerId: 'user_1',
              status: 'active',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ]),
        ),
        getMcaFromCatalog: mock(() =>
          Promise.resolve({
            mcpId: 'mca.test',
            name: 'Test MCA',
            description: 'A test MCA',
            tools: ['tool1', 'tool2'],
            status: 'active',
          }),
        ),
        getApp: mock(() => Promise.resolve(null)),
        createApp: mock(() =>
          Promise.resolve({
            appId: 'app_new',
            mcpId: 'mca.test',
            name: 'New App',
            ownerId: 'user_1',
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        ),
      };

      // Use the mock in tests
      const apps = await mockMcaService.listAppsByOwner!('user_1');
      expect(apps.length).toBe(1);
      expect(apps[0].name).toBe('Test App');

      const mca = await mockMcaService.getMcaFromCatalog!('mca.test');
      expect(mca?.name).toBe('Test MCA');
    });

    it('should support partial mocks for specific tests', async () => {
      // Only mock what you need for a specific test
      const mockMcaService: Pick<IMcaService, 'grantAccess' | 'revokeAccess'> = {
        grantAccess: mock(() =>
          Promise.resolve({
            agentId: 'agent_1',
            appId: 'app_1',
            grantedAt: new Date().toISOString(),
            grantedBy: 'user_1',
          }),
        ),
        revokeAccess: mock(() => Promise.resolve(true)),
      };

      const access = await mockMcaService.grantAccess({
        agentId: 'agent_1',
        appId: 'app_1',
        grantedBy: 'user_1',
      });

      expect(access.agentId).toBe('agent_1');

      const revoked = await mockMcaService.revokeAccess('agent_1', 'app_1');
      expect(revoked).toBe(true);
    });
  });

  describe('IChannelManager mock', () => {
    it('should be mockable for testing message handlers', async () => {
      const mockChannelManager: Partial<IChannelManager> = {
        getChannel: mock(() =>
          Promise.resolve({
            channelId: 'ch_1',
            userId: 'user_1',
            agentId: 'agent_1',
            status: 'active',
            metadata: { name: 'Test Channel', transport: 'websocket' },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        ),
        saveMessage: mock(() => Promise.resolve()),
        createMessageId: mock(() => 'msg_123'),
        getMessages: mock(() =>
          Promise.resolve({
            messages: [],
            hasMore: false,
          }),
        ),
      };

      const channel = await mockChannelManager.getChannel!('ch_1');
      expect(channel?.status).toBe('active');

      const messageId = mockChannelManager.createMessageId!();
      expect(messageId).toBe('msg_123');
    });
  });

  describe('IModelService mock', () => {
    it('should be mockable for testing LLM configuration', async () => {
      const mockModelService: Partial<IModelService> = {
        getEffectiveAgentConfig: mock(() =>
          Promise.resolve({
            llm: {
              modelId: 'model_1',
              provider: 'anthropic',
              modelString: 'claude-3-sonnet-20240229',
              temperature: 0.7,
              maxTokens: 4096,
              capabilities: { tools: true, vision: true, streaming: true },
              context: { maxTokens: 200000 },
              compaction: undefined,
            },
            systemPrompt: 'You are a helpful assistant.',
            agent: {
              agentId: 'agent_1',
              name: 'Alice',
              fullName: 'Alice Evergreen',
              role: 'assistant',
            },
          }),
        ),
        listModels: mock(() =>
          Promise.resolve([
            {
              modelId: 'model_1',
              name: 'Claude 3 Sonnet',
              provider: 'anthropic',
              modelString: 'claude-3-sonnet-20240229',
              status: 'active',
            },
          ]),
        ),
      };

      const config = await mockModelService.getEffectiveAgentConfig!('agent_1');
      expect(config?.llm.provider).toBe('anthropic');
      expect(config?.agent.name).toBe('Alice');
    });
  });

  describe('Integration example', () => {
    it('should show how to compose mocks for handler testing', async () => {
      // This demonstrates the pattern for testing handlers with mocked dependencies

      const mockMcaService: Partial<IMcaService> = {
        getAgentApps: mock(() =>
          Promise.resolve({
            agentId: 'agent_1',
            apps: [
              {
                app: {
                  appId: 'app_1',
                  name: 'Test App',
                  mcp: { mcpId: 'mca.test', name: 'Test', tools: [] },
                },
                access: { grantedAt: new Date().toISOString() },
              },
            ],
          }),
        ),
      };

      const mockChannelManager: Partial<IChannelManager> = {
        getChannel: mock(() =>
          Promise.resolve({
            channelId: 'ch_1',
            userId: 'user_1',
            agentId: 'agent_1',
            status: 'active',
            metadata: { name: 'Test', transport: 'websocket' },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        ),
      };

      // Simulate a handler that uses both services
      const simulateHandler = async (
        mcaSvc: Partial<IMcaService>,
        channelMgr: Partial<IChannelManager>,
        channelId: string,
      ) => {
        const channel = await channelMgr.getChannel!(channelId);
        if (!channel) return null;

        const agentApps = await mcaSvc.getAgentApps!(channel.agentId);
        return {
          channel,
          appCount: agentApps.apps.length,
        };
      };

      const result = await simulateHandler(mockMcaService, mockChannelManager, 'ch_1');
      expect(result?.appCount).toBe(1);
      expect(result?.channel.agentId).toBe('agent_1');
    });
  });
});
