/**
 * Tests for Provider Commands
 *
 * Covers the WebSocket handlers in provider-commands.ts (user-provider CRUD:
 * list / add / test / update / delete / oauth). The legacy agent-providers
 * commands (list_agent_providers / set_agent_providers /
 * set_agent_preferred_provider) were removed on 2026-10-21 with the
 * availableProviders concept — they were never registered on any router.
 * Agent model config lives in the agent domain: agent.list-providers /
 * agent.set-model (tested via the MCA tool handlers below).
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createProviderCommands } from '../../../../packages/backend/src/handlers/websocket/provider-commands';

describe('ProviderCommands', () => {
  let dbMock: any;
  let providerServiceMock: any;
  let sendMessageMock: ReturnType<typeof mock>;
  let sendErrorMock: ReturnType<typeof mock>;
  let wsMock: any;

  const userId = 'user_test123';
  const agentId = 'agent_test456';

  beforeEach(() => {
    dbMock = {
      collection: mock((name: string) => ({
        findOne: mock(() => Promise.resolve(null)),
        find: mock(() => ({ toArray: mock(() => Promise.resolve([])) })),
        updateOne: mock(() => Promise.resolve({ modifiedCount: 1 })),
        deleteOne: mock(() => Promise.resolve({ deletedCount: 1 })),
      })),
    };

    providerServiceMock = {
      listUserProviders: mock(() => Promise.resolve([])),
      addProvider: mock(() => Promise.resolve({ providerId: 'prov_new', providerType: 'anthropic', displayName: 'Test', status: 'active', priority: 0 })),
      testProvider: mock(() => Promise.resolve({ ok: true, models: [] })),
      setProviderSecrets: mock(() => Promise.resolve()),
      updateProvider: mock(() => Promise.resolve()),
    };

    sendMessageMock = mock(() => {});
    sendErrorMock = mock(() => {});

    wsMock = {
      readyState: 1, // OPEN
      send: mock(() => {}),
    };
  });

  const createCommands = () =>
    createProviderCommands({
      db: dbMock,
      providerService: providerServiceMock,
      sendMessage: sendMessageMock,
      sendError: sendErrorMock,
    });

  // ==========================================================================
  // handleListProviders (list_providers)
  // ==========================================================================

  describe('handleListProviders', () => {
    it('should return sanitized providers for the user', async () => {
      const providerRecords = [
        { providerId: 'prov_1', providerType: 'anthropic', displayName: 'Claude', status: 'active', models: ['claude-3'], auth: { apiKey: 'SECRET' } },
        { providerId: 'prov_2', providerType: 'openai', displayName: 'GPT-4', status: 'active', models: ['gpt-4'] },
      ];
      providerServiceMock.listUserProviders = mock(() => Promise.resolve(providerRecords));

      const commands = createCommands();
      await commands.handleListProviders(wsMock, userId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('providers_list');
      expect(response.providers.length).toBe(2);
      expect(response.providers[0].providerId).toBe('prov_1');
      // Encrypted auth data is never sent to the client.
      expect(response.providers[0].auth).toBeUndefined();
    });

    it('should handle errors gracefully', async () => {
      providerServiceMock.listUserProviders = mock(() => Promise.reject(new Error('DB error')));

      const commands = createCommands();
      await commands.handleListProviders(wsMock, userId);

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'LIST_PROVIDERS_ERROR', 'Failed to list providers');
    });
  });

  // ==========================================================================
  // handleAddProvider (add_provider)
  // ==========================================================================

  describe('handleAddProvider', () => {
    it('should require providerType and displayName', async () => {
      const commands = createCommands();
      await commands.handleAddProvider(wsMock, userId, { providerType: '', displayName: '' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'INVALID_INPUT', 'providerType and displayName are required');
    });

    it('should reject an invalid providerType', async () => {
      const commands = createCommands();
      await commands.handleAddProvider(wsMock, userId, { providerType: 'not-a-type', displayName: 'X' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'INVALID_PROVIDER_TYPE', 'Invalid providerType: not-a-type');
    });

    it('should add a provider without credentials', async () => {
      const commands = createCommands();
      await commands.handleAddProvider(wsMock, userId, { providerType: 'anthropic', displayName: 'Claude' });

      expect(providerServiceMock.addProvider).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('provider_added');
      expect(response.provider.providerId).toBe('prov_new');
    });

    it('should store the API key when provided', async () => {
      const commands = createCommands();
      await commands.handleAddProvider(wsMock, userId, {
        providerType: 'anthropic',
        displayName: 'Claude',
        auth: { apiKey: 'sk-test' },
      });

      expect(providerServiceMock.setProviderSecrets).toHaveBeenCalledWith(userId, 'prov_new', { apiKey: 'sk-test' });
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('should handle errors gracefully', async () => {
      providerServiceMock.addProvider = mock(() => Promise.reject(new Error('DB error')));

      const commands = createCommands();
      await commands.handleAddProvider(wsMock, userId, { providerType: 'anthropic', displayName: 'Claude' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'ADD_PROVIDER_ERROR', 'Failed to add provider');
    });
  });

  // ==========================================================================
  // handleTestProvider (test_provider)
  // ==========================================================================

  describe('handleTestProvider', () => {
    it('should require providerId', async () => {
      const commands = createCommands();
      await commands.handleTestProvider(wsMock, userId, { providerId: '' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'MISSING_PROVIDER_ID', 'providerId is required');
    });

    it('should reject a provider the user does not own', async () => {
      providerServiceMock.listUserProviders = mock(() =>
        Promise.resolve([{ providerId: 'prov_other', providerType: 'anthropic', displayName: 'X', status: 'active', models: [] }]),
      );

      const commands = createCommands();
      await commands.handleTestProvider(wsMock, userId, { providerId: 'prov_not_mine' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'PROVIDER_NOT_FOUND', 'Provider not found or not owned by user');
    });

    it('should test an owned provider', async () => {
      providerServiceMock.listUserProviders = mock(() =>
        Promise.resolve([{ providerId: 'prov_1', providerType: 'anthropic', displayName: 'X', status: 'active', models: [] }]),
      );
      providerServiceMock.testProvider = mock(() => Promise.resolve({ ok: true, models: ['claude-3'] }));

      const commands = createCommands();
      await commands.handleTestProvider(wsMock, userId, { providerId: 'prov_1' });

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('provider_tested');
      expect(response.ok).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      providerServiceMock.listUserProviders = mock(() => Promise.reject(new Error('DB error')));

      const commands = createCommands();
      await commands.handleTestProvider(wsMock, userId, { providerId: 'prov_1' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'TEST_PROVIDER_ERROR', 'Failed to test provider');
    });
  });

  // ==========================================================================
  // handleUpdateProvider (update_provider)
  // ==========================================================================

  describe('handleUpdateProvider', () => {
    it('should update displayName and priority of an owned provider', async () => {
      const updateOneMock = mock(() => Promise.resolve({ modifiedCount: 1 }));
      dbMock.collection = mock(() => ({ updateOne: updateOneMock }));
      providerServiceMock.listUserProviders = mock(() =>
        Promise.resolve([{ providerId: 'prov_1', providerType: 'anthropic', displayName: 'X', status: 'active', models: [] }]),
      );

      const commands = createCommands();
      await commands.handleUpdateProvider(wsMock, userId, { providerId: 'prov_1', displayName: 'New name', priority: 10 });

      expect(updateOneMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('provider_updated');
      expect(response.displayName).toBe('New name');
      expect(response.priority).toBe(10);
    });

    it('should reject a provider the user does not own', async () => {
      providerServiceMock.listUserProviders = mock(() => Promise.resolve([]));

      const commands = createCommands();
      await commands.handleUpdateProvider(wsMock, userId, { providerId: 'prov_not_mine', displayName: 'X' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'PROVIDER_NOT_FOUND', 'Provider not found or not owned by user');
    });

    it('should handle errors gracefully', async () => {
      providerServiceMock.listUserProviders = mock(() => Promise.reject(new Error('DB error')));

      const commands = createCommands();
      await commands.handleUpdateProvider(wsMock, userId, { providerId: 'prov_1' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'UPDATE_PROVIDER_ERROR', 'Failed to update provider');
    });
  });

  // ==========================================================================
  // handleDeleteProvider (delete_provider)
  // ==========================================================================

  describe('handleDeleteProvider', () => {
    it('should delete an owned provider', async () => {
      const deleteOneMock = mock(() => Promise.resolve({ deletedCount: 1 }));
      dbMock.collection = mock(() => ({ deleteOne: deleteOneMock }));
      providerServiceMock.listUserProviders = mock(() =>
        Promise.resolve([{ providerId: 'prov_1', providerType: 'anthropic', displayName: 'X', status: 'active', models: [] }]),
      );

      const commands = createCommands();
      await commands.handleDeleteProvider(wsMock, userId, { providerId: 'prov_1' });

      expect(deleteOneMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('provider_deleted');
      expect(response.providerId).toBe('prov_1');
    });

    it('should reject a provider the user does not own', async () => {
      providerServiceMock.listUserProviders = mock(() => Promise.resolve([]));

      const commands = createCommands();
      await commands.handleDeleteProvider(wsMock, userId, { providerId: 'prov_not_mine' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'PROVIDER_NOT_FOUND', 'Provider not found or not owned by user');
    });

    it('should handle errors gracefully', async () => {
      providerServiceMock.listUserProviders = mock(() => Promise.reject(new Error('DB error')));

      const commands = createCommands();
      await commands.handleDeleteProvider(wsMock, userId, { providerId: 'prov_1' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'DELETE_PROVIDER_ERROR', 'Failed to delete provider');
    });
  });
});

// =============================================================================
// REGRESSION TESTS — MCA Core tool handlers calling context methods
// =============================================================================
//
// Bug (commit e9b43c8a): agentProvidersGet existed in McaBackendClient but was
// NOT exposed in ToolContext nor in buildResourceMethods in
// packages/mca-sdk/src/http-server.ts. When the core MCA called
// context.agentProvidersGet(...), it threw:
//   "TypeError: context.agentProvidersGet is not a function"
//
// These tests import the tool handlers directly and verify they call the correct
// context methods — and that calling with a context missing those methods throws
// a descriptive error (not a silent undefined or wrong error).
//
// 2026-10-21: set-agent-providers and set-agent-preferred-provider tools were
// deleted with the availableProviders concept; the model tools are
// agent.set-model (single pin) and agent.reset-model (System Default).

import { agentProvidersGet } from '../../../../mcas/mca.teros.core/src/tools/agent-providers-get';
import { agentModelSet } from '../../../../mcas/mca.teros.core/src/tools/agent-model-set';
import { agentModelReset } from '../../../../mcas/mca.teros.core/src/tools/agent-model-reset';
import { providerList } from '../../../../mcas/mca.teros.core/src/tools/provider-list';

describe('Regression: agentProvidersGet missing from ToolContext (e9b43c8a)', () => {
  const makeFullContext = (overrides: Partial<Record<string, any>> = {}) => ({
    // verifyAgentExists (tools/utils.ts) calls context.agentGet to confirm the
    // agent exists before mutating; the mock just needs to resolve.
    agentGet: mock(() => Promise.resolve({ agentId: 'agent_1' })),
    agentProvidersGet: mock(() =>
      Promise.resolve({ selectedProviderId: null, selectedModelId: null, providers: [], resolved: null, warnings: [] }),
    ),
    agentModelSet: mock(() => Promise.resolve({ agentId: 'agent_1', selectedProviderId: 'prov_1', selectedModelId: 'm1' })),
    agentModelReset: mock(() => Promise.resolve({ agentId: 'agent_1', selectedProviderId: null, selectedModelId: null })),
    providerList: mock(() => Promise.resolve({ providers: [] })),
    ...overrides,
  });

  describe('get-agent-providers tool handler', () => {
    it('should call context.agentProvidersGet with the correct agentId', async () => {
      const context = makeFullContext();
      await agentProvidersGet.handler({ agentId: 'agent_abc' }, context as any);

      expect(context.agentProvidersGet).toHaveBeenCalledTimes(1);
      expect(context.agentProvidersGet).toHaveBeenCalledWith('agent_abc');
    });

    // @todo alice - 2026-04-03: regression test — covers the bug where agentProvidersGet
    // was missing from ToolContext / buildResourceMethods in mca-sdk/http-server.ts.
    // The fix was in commit e9b43c8a. This test ensures that if the method is ever
    // accidentally removed from the context again, the error is caught immediately.
    it('should throw a descriptive error if agentProvidersGet is missing from context', async () => {
      const incompleteContext = makeFullContext({ agentProvidersGet: undefined });

      await expect(
        agentProvidersGet.handler({ agentId: 'agent_abc' }, incompleteContext as any),
      ).rejects.toThrow(TypeError);
    });
  });

  describe('set-agent-model tool handler (single pin)', () => {
    it('should call context.agentModelSet with agentId, providerId and modelId', async () => {
      const context = makeFullContext();
      await agentModelSet.handler(
        { agentId: 'agent_abc', providerId: 'prov_1', modelId: 'm1' },
        context as any,
      );

      expect(context.agentModelSet).toHaveBeenCalledTimes(1);
      expect(context.agentModelSet).toHaveBeenCalledWith('agent_abc', 'prov_1', 'm1', {
        reason: undefined,
        allowReserved: undefined,
      });
    });

    it('should forward reason and allowReserved for the audit log', async () => {
      const context = makeFullContext();
      await agentModelSet.handler(
        { agentId: 'agent_abc', providerId: 'prov_1', modelId: 'm1', reason: 'cost optimization', allowReserved: true },
        context as any,
      );

      expect(context.agentModelSet).toHaveBeenCalledWith('agent_abc', 'prov_1', 'm1', {
        reason: 'cost optimization',
        allowReserved: true,
      });
    });
  });

  describe('reset-agent-model tool handler (System Default)', () => {
    it('should call context.agentModelReset with agentId', async () => {
      const context = makeFullContext();
      await agentModelReset.handler({ agentId: 'agent_abc' }, context as any);

      expect(context.agentModelReset).toHaveBeenCalledTimes(1);
      expect(context.agentModelReset).toHaveBeenCalledWith('agent_abc', { reason: undefined });
    });

    it('should forward the audit reason when provided', async () => {
      const context = makeFullContext();
      await agentModelReset.handler({ agentId: 'agent_abc', reason: 'back to system default' }, context as any);

      expect(context.agentModelReset).toHaveBeenCalledWith('agent_abc', { reason: 'back to system default' });
    });
  });

  describe('list-providers tool handler', () => {
    it('should call context.providerList', async () => {
      const context = makeFullContext();
      await providerList.handler({}, context as any);

      expect(context.providerList).toHaveBeenCalledTimes(1);
    });
  });
});
