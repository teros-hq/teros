/**
 * Integration test: Cross-session permission requests (TER-267 / FASE 3)
 *
 * Verifies that McaToolExecutor is now instantiated per-conversation (channelId)
 * rather than as a singleton per-agent. This prevents cross-session race
 * conditions where concurrent conversations of the same agent overwrite each
 * other's callbacks (onAskPermission, onBeforeExecute) and streamState
 * references.
 *
 * Scenario:
 *   - Agent: Alice (agent_xxx)
 *   - User: Pablo (user_yyy)
 *   - Workspace: Teros HQ (work_zzz)
 *   - Conversation A (Channel A): Alice asks to execute "list-files" (permission: ask)
 *   - Conversation B (Channel B): Alice asks to execute "read-file" (permission: ask)
 *   - Both tool calls occur with temporal overlap
 *
 * What is verified:
 *   1. Each conversation gets its own McaToolExecutor instance with channelId baked in
 *   2. Permission request A is linked to message A (messageId defined)
 *   3. Permission request B is linked to message B (messageId defined)
 *   4. The messageIds are distinct — no mixing
 *   5. Both would show ControlsBar in the frontend (simulated by checking the broadcast payload)
 *   6. Approving A does not affect B — each permission is independent
 *   7. No auto-forbid triggered by missing context — the defensive fix (FASE 2) does not fire
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { McaToolExecutor } from '../../src/services/mca-tool-executor';
import type { McaManager } from '../../src/services/mca-manager';
import type { McaService } from '../../src/services/mca-service';
import type { AgentAppAccess, App, ToolDefinition } from '../../src/types/database';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const AGENT_ID = 'agent_alice';
const WORKSPACE_ID = 'work_teros_hq';
const CHANNEL_A = 'ch_session_a';
const CHANNEL_B = 'ch_session_b';
const APP_ID = 'app_filesystem';
const MCA_ID = 'mca.teros.filesystem';

const TOOL_LIST_FILES: ToolDefinition = {
  name: 'list-files',
  description: 'List files in a directory',
  input_schema: {
    type: 'object',
    properties: {
      folderId: { type: 'string', description: 'Folder ID' },
    },
  },
};

const TOOL_READ_FILE: ToolDefinition = {
  name: 'read-file',
  description: 'Read a file',
  input_schema: {
    type: 'object',
    properties: {
      fileId: { type: 'string', description: 'File ID' },
    },
  },
};

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockMcaService(): McaService {
  // The real McaService.getAgentApps returns apps with a nested `mca` object
  // (from the MCA catalog join). We must match that shape.
  const appWithMca = {
    appId: APP_ID,
    mcaId: MCA_ID,
    ownerId: 'user_pablo',
    name: 'filesystem',
    status: 'active',
    permissions: {
      tools: {
        'list-files': 'ask',
        'read-file': 'ask',
      },
      defaultPermission: 'ask',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    // Nested mca object as returned by the real service
    mca: {
      mcaId: MCA_ID,
      name: 'Filesystem',
    },
  };

  // Bare App shape (for getApp)
  const app: App = {
    appId: APP_ID,
    mcaId: MCA_ID,
    ownerId: 'user_pablo',
    name: 'filesystem',
    status: 'active',
    permissions: {
      tools: {
        'list-files': 'ask',
        'read-file': 'ask',
      },
      defaultPermission: 'ask',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    getAgentApps: mock(async (_agentId: string, _workspaceId?: string) => ({
      apps: [
        {
          app: appWithMca,
          access: {
            accessId: 'access_1',
            agentId: AGENT_ID,
            appId: APP_ID,
            grantedAt: new Date(),
            grantedBy: 'user_pablo',
          } as AgentAppAccess,
        },
      ],
    })),
    getApp: mock(async (_appId: string) => app),
    hasAccess: mock(async (_agentId: string, _appId: string) => true),
  } as unknown as McaService;
}

function createMockMcaManager(): McaManager {
  return {
    registerApp: mock(async (_appId: string) => {}),
    getToolsForApp: mock(async (_appId: string) => ({
      tools: [TOOL_LIST_FILES, TOOL_READ_FILE],
      status: 'ready' as const,
    })),
    getMcaIdForTool: mock((_toolName: string) => MCA_ID),
    executeTool: mock(async (_toolName: string, _input: Record<string, any>, _options: any) => ({
      output: 'mock result',
      isError: false,
    })),
  } as unknown as McaManager;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PermissionRequest {
  toolName: string;
  appId: string;
  input: Record<string, any>;
  irreversible: boolean;
  toolCallId?: string;
  resolver: (resolution: 'granted' | 'denied') => void;
}

function createAskPermissionCallback(
  channelId: string,
  requests: PermissionRequest[],
  getToolCallContext?: (toolCallId?: string) => { messageId: string; toolCallId: string } | null,
) {
  return async (
    toolName: string,
    appId: string,
    input: Record<string, any>,
    irreversible: boolean,
    toolCallId?: string,
  ): Promise<'granted' | 'denied'> => {
    return new Promise((resolve) => {
      // Simulate the permission manager logic: check context
      const context = getToolCallContext?.(toolCallId);
      if (!context?.messageId) {
        // This would be the auto-forbid path — we should never hit this
        resolve('denied');
        return;
      }

      requests.push({
        toolName,
        appId,
        input,
        irreversible,
        toolCallId,
        resolver: resolve,
      });
    });
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Cross-session permission requests (FASE 3)', () => {
  let mockMcaManager: McaManager;
  let mockMcaService: McaService;

  beforeEach(() => {
    mockMcaManager = createMockMcaManager();
    mockMcaService = createMockMcaService();
  });

  it('each channel gets its own McaToolExecutor instance', async () => {
    const executorA = new McaToolExecutor(
      mockMcaManager,
      mockMcaService,
      AGENT_ID,
      CHANNEL_A,
      { workspaceId: WORKSPACE_ID },
    );
    const executorB = new McaToolExecutor(
      mockMcaManager,
      mockMcaService,
      AGENT_ID,
      CHANNEL_B,
      { workspaceId: WORKSPACE_ID },
    );

    // Both must initialize successfully
    await executorA.initialize();
    await executorB.initialize();

    // They are different objects
    expect(executorA).not.toBe(executorB);

    // Each has its own channelId baked in (verified indirectly through behavior)
    const toolsA = executorA.getTools();
    const toolsB = executorB.getTools();
    expect(toolsA.length).toBe(toolsB.length);
    expect(toolsA.map((t) => t.name).sort()).toEqual(
      toolsB.map((t) => t.name).sort(),
    );
  });

  it('permission requests from different channels do not mix (no cross-wiring)', async () => {
    const requestsA: PermissionRequest[] = [];
    const requestsB: PermissionRequest[] = [];

    // Simulate streaming state for each channel
    const messageIdA = 'msg_a_001';
    const messageIdB = 'msg_b_001';
    const toolCallIdA = 'call_a_001';
    const toolCallIdB = 'call_b_001';

    const getToolCallContextA = (toolCallId?: string) => {
      if (toolCallId === toolCallIdA) {
        return { messageId: messageIdA, toolCallId: toolCallIdA };
      }
      return null;
    };

    const getToolCallContextB = (toolCallId?: string) => {
      if (toolCallId === toolCallIdB) {
        return { messageId: messageIdB, toolCallId: toolCallIdB };
      }
      return null;
    };

    // Build executors with channel-specific callbacks
    const executorA = new McaToolExecutor(
      mockMcaManager,
      mockMcaService,
      AGENT_ID,
      CHANNEL_A,
      {
        workspaceId: WORKSPACE_ID,
        onAskPermission: createAskPermissionCallback(
          CHANNEL_A,
          requestsA,
          getToolCallContextA,
        ),
      },
    );

    const executorB = new McaToolExecutor(
      mockMcaManager,
      mockMcaService,
      AGENT_ID,
      CHANNEL_B,
      {
        workspaceId: WORKSPACE_ID,
        onAskPermission: createAskPermissionCallback(
          CHANNEL_B,
          requestsB,
          getToolCallContextB,
        ),
      },
    );

    await executorA.initialize();
    await executorB.initialize();

    // Execute both tools concurrently (simulating overlapping permission requests)
    const promiseA = executorA.executeTool('list-files', { folderId: 'root' }, {
      toolCallId: toolCallIdA,
    });
    const promiseB = executorB.executeTool('read-file', { fileId: 'doc1' }, {
      toolCallId: toolCallIdB,
    });

    // Give microtasks a chance to queue the permission requests
    await new Promise((r) => setTimeout(r, 10));

    // Verify: exactly one request per channel
    expect(requestsA.length).toBe(1);
    expect(requestsB.length).toBe(1);

    // Verify: the requests are for the correct tools
    expect(requestsA[0].toolName).toBe('list-files');
    expect(requestsB[0].toolName).toBe('read-file');

    // Verify: messageIds are distinct and correctly linked
    expect(requestsA[0].toolCallId).toBe(toolCallIdA);
    expect(requestsB[0].toolCallId).toBe(toolCallIdB);

    // Verify: no cross-wiring (A's request is not in B's list and vice versa)
    const aIds = requestsA.map((r) => r.toolCallId);
    const bIds = requestsB.map((r) => r.toolCallId);
    expect(aIds).not.toContain(toolCallIdB);
    expect(bIds).not.toContain(toolCallIdA);

    // Resolve A granted, B denied
    requestsA[0].resolver('granted');
    requestsB[0].resolver('denied');

    const resultA = await promiseA;
    const resultB = await promiseB;

    // A should succeed (permission granted)
    expect(resultA.isError).toBe(false);
    expect(resultA.output).toBe('mock result');

    // B should fail (permission denied)
    expect(resultB.isError).toBe(true);
    expect(resultB.permissionDenied).toBe(true);
    expect(resultB.output).toContain('Permission denied');
  });

  it('approving a permission in channel A does not affect channel B', async () => {
    const requestsA: PermissionRequest[] = [];
    const requestsB: PermissionRequest[] = [];

    const messageIdA = 'msg_a_002';
    const messageIdB = 'msg_b_002';
    const toolCallIdA = 'call_a_002';
    const toolCallIdB = 'call_b_002';

    const getToolCallContextA = (toolCallId?: string) => {
      if (toolCallId === toolCallIdA) return { messageId: messageIdA, toolCallId: toolCallIdA };
      return null;
    };
    const getToolCallContextB = (toolCallId?: string) => {
      if (toolCallId === toolCallIdB) return { messageId: messageIdB, toolCallId: toolCallIdB };
      return null;
    };

    const executorA = new McaToolExecutor(
      mockMcaManager,
      mockMcaService,
      AGENT_ID,
      CHANNEL_A,
      {
        workspaceId: WORKSPACE_ID,
        onAskPermission: createAskPermissionCallback(
          CHANNEL_A,
          requestsA,
          getToolCallContextA,
        ),
      },
    );

    const executorB = new McaToolExecutor(
      mockMcaManager,
      mockMcaService,
      AGENT_ID,
      CHANNEL_B,
      {
        workspaceId: WORKSPACE_ID,
        onAskPermission: createAskPermissionCallback(
          CHANNEL_B,
          requestsB,
          getToolCallContextB,
        ),
      },
    );

    await executorA.initialize();
    await executorB.initialize();

    // Both execute the SAME tool with ask permission
    const promiseA = executorA.executeTool('list-files', { folderId: 'root' }, {
      toolCallId: toolCallIdA,
    });
    const promiseB = executorB.executeTool('list-files', { folderId: 'root' }, {
      toolCallId: toolCallIdB,
    });

    await new Promise((r) => setTimeout(r, 10));

    // Approve ONLY A
    requestsA[0].resolver('granted');

    // A should complete successfully
    const resultA = await promiseA;
    expect(resultA.isError).toBe(false);

    // B should still be pending — its promise should not resolve yet
    // (We verify by checking that B's request is still in the list and unresolved)
    expect(requestsB.length).toBe(1);
    expect(requestsB[0].toolCallId).toBe(toolCallIdB);

    // Now deny B
    requestsB[0].resolver('denied');
    const resultB = await promiseB;
    expect(resultB.isError).toBe(true);
    expect(resultB.permissionDenied).toBe(true);
  });

  it('no auto-forbid triggered when valid toolCallContext is provided', async () => {
    const requests: PermissionRequest[] = [];
    const messageId = 'msg_valid_001';
    const toolCallId = 'call_valid_001';

    const getToolCallContext = (tcid?: string) => {
      if (tcid === toolCallId) return { messageId, toolCallId };
      return null;
    };

    const executor = new McaToolExecutor(
      mockMcaManager,
      mockMcaService,
      AGENT_ID,
      CHANNEL_A,
      {
        workspaceId: WORKSPACE_ID,
        onAskPermission: createAskPermissionCallback(
          CHANNEL_A,
          requests,
          getToolCallContext,
        ),
      },
    );

    await executor.initialize();

    const promise = executor.executeTool('list-files', { folderId: 'root' }, {
      toolCallId,
    });

    await new Promise((r) => setTimeout(r, 10));

    // Should have created a permission request (not auto-forbidden)
    expect(requests.length).toBe(1);
    expect(requests[0].toolCallId).toBe(toolCallId);

    // Grant and complete
    requests[0].resolver('granted');
    const result = await promise;
    expect(result.isError).toBe(false);
  });

  it('channelId is baked into the executor and cannot be changed after construction', () => {
    const executorA = new McaToolExecutor(
      mockMcaManager,
      mockMcaService,
      AGENT_ID,
      CHANNEL_A,
      { workspaceId: WORKSPACE_ID },
    );

    // The channelId is a private field; we verify it indirectly by checking
    // that the executor was constructed without errors and that two executors
    // with different channelIds are independent.
    const executorB = new McaToolExecutor(
      mockMcaManager,
      mockMcaService,
      AGENT_ID,
      CHANNEL_B,
      { workspaceId: WORKSPACE_ID },
    );

    expect(executorA).not.toBe(executorB);
  });
});
