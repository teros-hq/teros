/**
 * Tests for Catalog Commands
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createCatalogCommands } from '../../../../packages/backend/src/handlers/websocket/catalog-commands';

describe('CatalogCommands', () => {
  let mcaServiceMock: any;
  let modelServiceMock: any;
  let sendMessageMock: ReturnType<typeof mock>;
  let sendErrorMock: ReturnType<typeof mock>;
  let buildAvatarUrlMock: ReturnType<typeof mock>;
  let wsMock: any;

  beforeEach(() => {
    mcaServiceMock = {
      listCatalog: mock(() => Promise.resolve([])),
    };

    modelServiceMock = {
      listModels: mock(() => Promise.resolve([])),
      listAgentCores: mock(() => Promise.resolve([])),
      updateAgentCore: mock(() => Promise.resolve(null)),
    };

    sendMessageMock = mock(() => {});
    sendErrorMock = mock(() => {});
    buildAvatarUrlMock = mock((filename?: string) =>
      filename ? `https://static.test/${filename}` : undefined,
    );

    wsMock = {
      readyState: 1,
      send: mock(() => {}),
    };
  });

  const createCommands = () =>
    createCatalogCommands({
      mcaService: mcaServiceMock,
      modelService: modelServiceMock,
      sendMessage: sendMessageMock,
      sendError: sendErrorMock,
      buildAvatarUrl: buildAvatarUrlMock,
    });

  describe('handleListCatalog', () => {
    it('should list available MCAs from catalog', async () => {
      mcaServiceMock.listCatalog = mock(() =>
        Promise.resolve([
          {
            mcpId: 'mca.test1',
            name: 'Test MCA 1',
            description: 'Description 1',
            icon: '🔧',
            color: '#ff0000',
            category: 'tools',
            tools: ['tool1', 'tool2'],
            availability: { enabled: true, multi: false, system: false, hidden: false },
          },
          {
            mcpId: 'mca.test2',
            name: 'Test MCA 2',
            description: 'Description 2',
            availability: { enabled: true },
          },
        ]),
      );

      const commands = createCommands();
      await commands.handleListCatalog(wsMock);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('catalog_list');
      expect(response.catalog.length).toBe(2);
      expect(response.catalog[0].mcpId).toBe('mca.test1');
    });

    it('should filter out disabled MCAs', async () => {
      mcaServiceMock.listCatalog = mock(() =>
        Promise.resolve([
          { mcpId: 'mca.enabled', availability: { enabled: true } },
          { mcpId: 'mca.disabled', availability: { enabled: false } },
        ]),
      );

      const commands = createCommands();
      await commands.handleListCatalog(wsMock);

      const response = sendMessageMock.mock.calls[0][1];
      expect(response.catalog.length).toBe(1);
      expect(response.catalog[0].mcpId).toBe('mca.enabled');
    });

    it('should filter out hidden MCAs', async () => {
      mcaServiceMock.listCatalog = mock(() =>
        Promise.resolve([
          { mcpId: 'mca.visible', availability: { enabled: true, hidden: false } },
          { mcpId: 'mca.hidden', availability: { enabled: true, hidden: true } },
        ]),
      );

      const commands = createCommands();
      await commands.handleListCatalog(wsMock);

      const response = sendMessageMock.mock.calls[0][1];
      expect(response.catalog.length).toBe(1);
      expect(response.catalog[0].mcpId).toBe('mca.visible');
    });

    it('should handle errors gracefully', async () => {
      mcaServiceMock.listCatalog = mock(() => Promise.reject(new Error('DB error')));

      const commands = createCommands();
      await commands.handleListCatalog(wsMock);

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'LIST_CATALOG_ERROR',
        'Failed to list catalog',
      );
    });
  });

  describe('handleListModels', () => {
    it('should list available models', async () => {
      modelServiceMock.listModels = mock(() =>
        Promise.resolve([
          {
            modelId: 'model_1',
            name: 'Claude 3 Sonnet',
            provider: 'anthropic',
            description: 'Fast and capable',
            modelString: 'claude-3-sonnet-20240229',
            context: { maxTokens: 200000 },
            status: 'active',
          },
        ]),
      );

      const commands = createCommands();
      await commands.handleListModels(wsMock);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('models_list');
      expect(response.models.length).toBe(1);
      expect(response.models[0].provider).toBe('anthropic');
    });

    it('should handle errors gracefully', async () => {
      modelServiceMock.listModels = mock(() => Promise.reject(new Error('Error')));

      const commands = createCommands();
      await commands.handleListModels(wsMock);

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'LIST_MODELS_ERROR',
        'Failed to list models',
      );
    });
  });

  describe('handleListAgentCores', () => {
    it('should list agent cores with avatar URLs', async () => {
      modelServiceMock.listAgentCores = mock(() =>
        Promise.resolve([
          {
            coreId: 'core_1',
            name: 'Alice',
            fullName: 'Alice Evergreen',
            version: '1.0',
            systemPrompt: 'You are Alice',
            avatarUrl: 'alice.png',
            modelId: 'model_1',
            status: 'active',
          },
        ]),
      );

      const commands = createCommands();
      await commands.handleListAgentCores(wsMock, {});

      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('agent_cores_list');
      expect(response.cores[0].avatarUrl).toBe('https://static.test/alice.png');
    });

    it('should filter by status when provided', async () => {
      const commands = createCommands();
      await commands.handleListAgentCores(wsMock, { status: 'active' });

      expect(modelServiceMock.listAgentCores).toHaveBeenCalledWith('active');
    });
  });

  describe('handleUpdateAgentCore', () => {
    it('should update agent core', async () => {
      modelServiceMock.updateAgentCore = mock(() =>
        Promise.resolve({
          coreId: 'core_1',
          name: 'Updated Name',
          status: 'active',
        }),
      );

      const commands = createCommands();
      await commands.handleUpdateAgentCore(wsMock, {
        coreId: 'core_1',
        updates: { name: 'Updated Name' },
      });

      expect(sendMessageMock.mock.calls[0][1].type).toBe('agent_core_updated');
    });

    it('should return error if core not found', async () => {
      modelServiceMock.updateAgentCore = mock(() => Promise.resolve(null));

      const commands = createCommands();
      await commands.handleUpdateAgentCore(wsMock, { coreId: 'nonexistent', updates: {} });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'AGENT_CORE_NOT_FOUND',
        'Agent core nonexistent not found',
      );
    });
  });
});
