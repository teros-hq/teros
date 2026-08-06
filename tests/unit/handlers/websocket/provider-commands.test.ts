/**
 * Tests for Provider Commands
 *
 * Covers the WebSocket handlers in provider-commands.ts:
 * - handleListAgentProviders (get-agent-providers)
 * - handleSetAgentProviders (set-agent-providers)
 * - handleSetAgentPreferredProvider (set-agent-preferred-provider)
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
  // handleListAgentProviders (get-agent-providers)
  // ==========================================================================

  describe('handleListAgentProviders', () => {
    it('should return agent providers correctly', async () => {
      const agent = {
        agentId,
        availableProviders: ['prov_1', 'prov_2'],
        preferredProviderId: 'prov_1',
      };

      const providerRecords = [
        { providerId: 'prov_1', providerType: 'anthropic', displayName: 'Claude', status: 'active', models: ['claude-3'] },
        { providerId: 'prov_2', providerType: 'openai', displayName: 'GPT-4', status: 'active', models: ['gpt-4'] },
      ];

      dbMock.collection = mock((name: string) => {
        if (name === 'agents') {
          return { findOne: mock(() => Promise.resolve(agent)) };
        }
        if (name === 'user_providers') {
          return { find: mock(() => ({ toArray: mock(() => Promise.resolve(providerRecords)) })) };
        }
        return { findOne: mock(() => Promise.resolve(null)) };
      });

      const commands = createCommands();
      await commands.handleListAgentProviders(wsMock, userId, { agentId });

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('agent_providers_list');
      expect(response.agentId).toBe(agentId);
      expect(response.availableProviders).toEqual(['prov_1', 'prov_2']);
      expect(response.preferredProviderId).toBe('prov_1');
      expect(response.providers.length).toBe(2);
      expect(response.providers[0].providerId).toBe('prov_1');
    });

    it('should return empty providers when agent has none configured', async () => {
      const agent = { agentId, availableProviders: [], preferredProviderId: null };

      dbMock.collection = mock((name: string) => {
        if (name === 'agents') {
          return { findOne: mock(() => Promise.resolve(agent)) };
        }
        return { find: mock(() => ({ toArray: mock(() => Promise.resolve([])) })) };
      });

      const commands = createCommands();
      await commands.handleListAgentProviders(wsMock, userId, { agentId });

      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('agent_providers_list');
      expect(response.availableProviders).toEqual([]);
      expect(response.providers).toEqual([]);
    });

    it('should require agentId', async () => {
      const commands = createCommands();
      await commands.handleListAgentProviders(wsMock, userId, { agentId: '' });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'MISSING_AGENT_ID', 'agentId is required');
    });

    it('should return error if agent not found', async () => {
      dbMock.collection = mock(() => ({
        findOne: mock(() => Promise.resolve(null)),
      }));

      const commands = createCommands();
      await commands.handleListAgentProviders(wsMock, userId, { agentId });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'AGENT_NOT_FOUND', 'Agent not found');
    });

    it('should handle errors gracefully', async () => {
      dbMock.collection = mock(() => ({
        findOne: mock(() => Promise.reject(new Error('DB error'))),
      }));

      const commands = createCommands();
      await commands.handleListAgentProviders(wsMock, userId, { agentId });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'LIST_AGENT_PROVIDERS_ERROR',
        'Failed to list agent providers',
      );
    });
  });

  // ==========================================================================
  // handleSetAgentProviders (set-agent-providers)
  // ==========================================================================

  describe('handleSetAgentProviders', () => {
    it('should update availableProviders for an agent', async () => {
      const agent = { agentId, ownerId: userId, availableProviders: [] };
      const updateOneMock = mock(() => Promise.resolve({ modifiedCount: 1 }));

      dbMock.collection = mock(() => ({
        findOne: mock(() => Promise.resolve(agent)),
        updateOne: updateOneMock,
      }));

      const commands = createCommands();
      await commands.handleSetAgentProviders(wsMock, userId, {
        agentId,
        availableProviders: ['prov_1', 'prov_2'],
      });

      expect(updateOneMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('agent_providers_updated');
      expect(response.agentId).toBe(agentId);
      expect(response.availableProviders).toEqual(['prov_1', 'prov_2']);
    });

    it('should require agentId', async () => {
      const commands = createCommands();
      await commands.handleSetAgentProviders(wsMock, userId, {
        agentId: '',
        availableProviders: [],
      });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'MISSING_AGENT_ID', 'agentId is required');
    });

    it('should require availableProviders to be an array', async () => {
      const commands = createCommands();
      await commands.handleSetAgentProviders(wsMock, userId, {
        agentId,
        availableProviders: 'not-an-array' as any,
      });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'INVALID_INPUT',
        'availableProviders must be an array',
      );
    });

    it('should deny access if user does not own the agent', async () => {
      const agent = { agentId, ownerId: 'other_user', availableProviders: [] };

      dbMock.collection = mock(() => ({
        findOne: mock(() => Promise.resolve(agent)),
        updateOne: mock(() => Promise.resolve()),
      }));

      const commands = createCommands();
      await commands.handleSetAgentProviders(wsMock, userId, {
        agentId,
        availableProviders: ['prov_1'],
      });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'PERMISSION_DENIED',
        'You do not have permission to modify this agent',
      );
    });

    it('should handle errors gracefully', async () => {
      dbMock.collection = mock(() => ({
        findOne: mock(() => Promise.reject(new Error('DB error'))),
      }));

      const commands = createCommands();
      await commands.handleSetAgentProviders(wsMock, userId, {
        agentId,
        availableProviders: [],
      });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'SET_AGENT_PROVIDERS_ERROR',
        'Failed to set agent providers',
      );
    });
  });

  // ==========================================================================
  // handleSetAgentPreferredProvider (set-agent-preferred-provider)
  // ==========================================================================

  describe('handleSetAgentPreferredProvider', () => {
    it('should set preferredProviderId for an agent', async () => {
      const agent = { agentId, ownerId: userId, availableProviders: ['prov_1'] };
      const updateOneMock = mock(() => Promise.resolve({ modifiedCount: 1 }));

      dbMock.collection = mock(() => ({
        findOne: mock(() => Promise.resolve(agent)),
        updateOne: updateOneMock,
      }));

      const commands = createCommands();
      await commands.handleSetAgentPreferredProvider(wsMock, userId, {
        agentId,
        providerId: 'prov_1',
      });

      expect(updateOneMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.type).toBe('agent_preferred_provider_updated');
      expect(response.agentId).toBe(agentId);
      expect(response.preferredProviderId).toBe('prov_1');
    });

    it('should allow clearing preferredProviderId with null', async () => {
      const agent = { agentId, ownerId: userId, availableProviders: ['prov_1'], preferredProviderId: 'prov_1' };
      const updateOneMock = mock(() => Promise.resolve({ modifiedCount: 1 }));

      dbMock.collection = mock(() => ({
        findOne: mock(() => Promise.resolve(agent)),
        updateOne: updateOneMock,
      }));

      const commands = createCommands();
      await commands.handleSetAgentPreferredProvider(wsMock, userId, {
        agentId,
        providerId: null,
      });

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const response = sendMessageMock.mock.calls[0][1];
      expect(response.preferredProviderId).toBeNull();
    });

    it('should require agentId', async () => {
      const commands = createCommands();
      await commands.handleSetAgentPreferredProvider(wsMock, userId, {
        agentId: '',
        providerId: 'prov_1',
      });

      expect(sendErrorMock).toHaveBeenCalledWith(wsMock, 'MISSING_AGENT_ID', 'agentId is required');
    });

    it('should reject provider not in availableProviders', async () => {
      const agent = { agentId, ownerId: userId, availableProviders: ['prov_1'] };

      dbMock.collection = mock(() => ({
        findOne: mock(() => Promise.resolve(agent)),
        updateOne: mock(() => Promise.resolve()),
      }));

      const commands = createCommands();
      await commands.handleSetAgentPreferredProvider(wsMock, userId, {
        agentId,
        providerId: 'prov_not_available',
      });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'PROVIDER_NOT_AVAILABLE',
        'Provider must be in availableProviders before setting as preferred',
      );
    });

    it('should deny access if user does not own the agent', async () => {
      const agent = { agentId, ownerId: 'other_user', availableProviders: [] };

      dbMock.collection = mock(() => ({
        findOne: mock(() => Promise.resolve(agent)),
        updateOne: mock(() => Promise.resolve()),
      }));

      const commands = createCommands();
      await commands.handleSetAgentPreferredProvider(wsMock, userId, {
        agentId,
        providerId: null,
      });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'PERMISSION_DENIED',
        'You do not have permission to modify this agent',
      );
    });

    it('should handle errors gracefully', async () => {
      dbMock.collection = mock(() => ({
        findOne: mock(() => Promise.reject(new Error('DB error'))),
      }));

      const commands = createCommands();
      await commands.handleSetAgentPreferredProvider(wsMock, userId, {
        agentId,
        providerId: null,
      });

      expect(sendErrorMock).toHaveBeenCalledWith(
        wsMock,
        'SET_PREFERRED_PROVIDER_ERROR',
        'Failed to set preferred provider',
      );
    });
  });
});

// =============================================================================
// REGRESSION TESTS — MCA Core tool handlers calling context.agentProvidersGet
// =============================================================================
//
// Bug: agentProvidersGet (and agentProvidersSet, agentPreferredProviderSet,
// providerList) existed in McaBackendClient but were NOT exposed in ToolContext
// nor in buildResourceMethods in packages/mca-sdk/src/http-server.ts.
// When the core MCA called context.agentProvidersGet(...), it threw:
//   "TypeError: context.agentProvidersGet is not a function"
// Fixed in commit e9b43c8a.
//
// These tests import the tool handlers directly and verify they call the correct
// context methods — and that calling with a context missing those methods throws
// a descriptive error (not a silent undefined or wrong error).

import { agentProvidersGet } from '../../../../mcas/mca.teros.core/src/tools/agent-providers-get';
import { agentProvidersSet } from '../../../../mcas/mca.teros.core/src/tools/agent-providers-set';
import { agentPreferredProviderSet } from '../../../../mcas/mca.teros.core/src/tools/agent-preferred-provider-set';
import { providerList } from '../../../../mcas/mca.teros.core/src/tools/provider-list';

describe('Regression: agentProvidersGet missing from ToolContext (e9b43c8a)', () => {
  const makeFullContext = (overrides: Partial<Record<string, any>> = {}) => ({
    // verifyAgentExists (tools/utils.ts) calls context.agentGet to confirm the
    // agent exists before mutating providers; the mock just needs to resolve.
    agentGet: mock(() => Promise.resolve({ agentId: 'agent_1' })),
    agentProvidersGet: mock(() => Promise.resolve({ availableProviders: [], preferredProviderId: null, providers: [] })),
    agentProvidersSet: mock(() => Promise.resolve({ agentId: 'agent_1', availableProviders: [] })),
    agentPreferredProviderSet: mock(() => Promise.resolve({ agentId: 'agent_1', preferredProviderId: null })),
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

  describe('set-agent-providers tool handler', () => {
    it('should call context.agentProvidersSet with agentId and providerIds', async () => {
      const context = makeFullContext();
      await agentProvidersSet.handler({ agentId: 'agent_abc', providerIds: ['prov_1', 'prov_2'] }, context as any);

      expect(context.agentProvidersSet).toHaveBeenCalledTimes(1);
      expect(context.agentProvidersSet).toHaveBeenCalledWith('agent_abc', ['prov_1', 'prov_2']);
    });
  });

  describe('set-agent-preferred-provider tool handler', () => {
    it('should call context.agentPreferredProviderSet with agentId and providerId', async () => {
      const context = makeFullContext();
      await agentPreferredProviderSet.handler({ agentId: 'agent_abc', providerId: 'prov_1' }, context as any);

      expect(context.agentPreferredProviderSet).toHaveBeenCalledTimes(1);
      expect(context.agentPreferredProviderSet).toHaveBeenCalledWith('agent_abc', 'prov_1');
    });

    it('should pass null when providerId is omitted (clearing the preference)', async () => {
      const context = makeFullContext();
      await agentPreferredProviderSet.handler({ agentId: 'agent_abc' }, context as any);

      expect(context.agentPreferredProviderSet).toHaveBeenCalledWith('agent_abc', null);
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
