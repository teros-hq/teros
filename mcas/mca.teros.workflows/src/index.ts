#!/usr/bin/env bun

/**
 * Workflows MCA v1.0.0
 *
 * Create, execute, and query visual workflows.
 *
 * Thin client. This MCA no longer holds a MongoDB connection nor runs the
 * WorkflowEngine locally: every tool forwards to a named backend action
 * (`workflows/<action>`) through the authenticated callback, and the backend
 * executes it against the shared flows / executions / artifacts collections
 * with its own engine (datastore-isolation P1b). The tool definitions —
 * names, parameters, result shapes, structured error payloads — are unchanged,
 * so the Flow* windows and agents see exactly the former contract.
 *
 * Tools:
 * - create-flow: Create a new flow with nodes, edges, and triggers
 * - get-flow: Get a flow by ID (full graph)
 * - list-flows: List flows in a workspace, optionally filtered by status
 * - delete-flow: Permanently delete a flow by ID
 * - execute-flow: Start a new execution of a flow
 * - advance-flow: Advance an execution after a task completes
 * - get-execution: Get execution status + steps + summary
 * - cancel-execution: Cancel a stale/failed/running execution
 * - list-executions: List executions with optional flow/status filters
 * - create-artifact: Create a named schema definition for gates
 * - list-artifacts: List artifacts, optionally filtered by scope
 * - update-artifact: Update an artifact's name, title, schema, etc.
 * - delete-artifact: Permanently delete an artifact
 */

import { McaServer, healthIssue, notReady, ready, type ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// BACKEND ACTION CLIENT
// =============================================================================

/** Minimal structural view of the tool context we rely on. */
interface ActionContext {
  backend: { invokeAction<T = unknown>(actionPath: string, body?: Record<string, unknown>): Promise<T> } | null;
  execution?: { channelId?: string; agentId?: string };
}

/** Error body the backend action dispatcher answers with on failure. */
interface ActionErrorBody {
  error?: string;
  code?: string;
  suggestion?: string;
}

/**
 * Structured tool result — the same wrapper the former tools produced:
 * JSON text content + structuredContent for clients that read it directly.
 */
function structured<T>(data: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

/**
 * Convert any failure into the structured JSON-string error the UI parses
 * (parseFlowError): {"error":true,"code":"...","message":"...","suggestion":...}.
 * The backend dispatcher forwards the action's domain `code` and `suggestion`,
 * so NOT_FOUND / NO_START_NODE / ALREADY_TERMINAL / ... survive the hop intact.
 */
function toToolError(error: unknown): never {
  const response = (error as { response?: unknown } | null)?.response;
  if (response && typeof response === 'object') {
    const body = response as ActionErrorBody;
    if (typeof body.error === 'string') {
      throw new Error(
        JSON.stringify({
          error: true,
          code: body.code ?? 'INTERNAL_ERROR',
          message: body.error,
          suggestion: body.suggestion ?? null,
        }),
      );
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(JSON.stringify({ error: true, code: 'INTERNAL_ERROR', message, suggestion: null }));
}

/**
 * Invoke `workflows/<action>` with the tool args. `workspaceId` is dropped —
 * the backend derives the workspace from the verified token and ignores any
 * caller-supplied value. `extra` carries context the backend cannot see
 * (e.g. the channelId a schedule should post into).
 */
async function invoke(
  context: ActionContext,
  action: string,
  args: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  const backend = context.backend;
  if (!backend) {
    throw new Error(
      JSON.stringify({
        error: true,
        code: 'INTERNAL_ERROR',
        message: 'workflows requires the backend callback (no callbackUrl in execution context)',
        suggestion: null,
      }),
    );
  }
  const { workspaceId: _ignored, ...body } = args;
  try {
    return await backend.invokeAction(`workflows/${action}`, { ...body, ...extra });
  } catch (error) {
    return toToolError(error);
  }
}

/** Build a tool handler that forwards to one action and wraps the result. */
function forward(action: string, extra?: (context: ActionContext) => Record<string, unknown>) {
  return async (args: Record<string, unknown>, context: unknown) => {
    const ctx = context as ActionContext;
    return structured(await invoke(ctx, action, args, extra ? extra(ctx) : {}));
  };
}

/** Drop empty values so they don't travel as explicit nulls. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

const healthCheck: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Internal health check tool. Verifies MongoDB and WebSocket connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const backend = (context as ActionContext).backend;
    if (!backend) {
      return notReady(healthIssue('DEPENDENCY_UNAVAILABLE', 'Backend callback not configured'));
    }
    try {
      await backend.invokeAction('workflows/ping');
      return ready('1.0.0');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return notReady(healthIssue('DEPENDENCY_UNAVAILABLE', `Backend actions unreachable: ${message}`));
    }
  },
};

// =============================================================================
// FLOW MANAGEMENT
// =============================================================================

const createFlow: ToolConfig = {
  description:
    'Create a new workflow flow — a directed graph of nodes connected by typed gates. Nodes: start (entry point), action (creates a board task), end (terminal), function (executes code), pin (proxy/rerouting), integration (external MCA). Gates reference Artifacts via schemaId (or null for signal-only). Edges connect output gates to input gates. Triggers define how the flow starts (manual, schedule, webhook, event). Returns the created flow with generated IDs.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Human-readable flow name.' },
      description: { type: 'string', description: 'What this flow does.' },
      nodes: {
        type: 'array',
        description: 'Nodes in the graph. Must include at least one start node.',
        items: {
          type: 'object',
          properties: {
            nodeId: { type: 'string', description: 'Unique ID within the flow (auto-generated if omitted).' },
            type: { type: 'string', enum: ['start', 'action', 'end', 'function', 'pin', 'integration', 'split', 'join'], description: 'Node type — determines processing behavior.' },
            label: { type: 'string', description: 'Human-readable label.' },
            description: { type: 'string', description: 'What this node does.' },
            instructions: { type: 'string', description: 'Instructions sent to the agent/human (supports {{variable}} interpolation from input gate data).' },
            role: { type: 'string', description: 'Who executes: agentId or "human". Ignored for non-action nodes.' },
            color: { type: 'string', description: 'Color for visual identification (hex).' },
            direction: { type: 'string', description: 'Visual layout direction.' },
            inputs: { type: 'array', description: 'Input gates — data the node receives.', items: { type: 'object' } },
            outputs: { type: 'array', description: 'Output gates — data the node produces.', items: { type: 'object' } },
            position: { type: 'object', description: 'Visual position in the editor.', properties: { x: { type: 'number' }, y: { type: 'number' } } },
            data: { type: 'object', description: 'Node-specific configuration (e.g., function code, integration config).' },
          },
        },
      },
      edges: {
        type: 'array',
        description: 'Connections from output gates to input gates.',
        items: { type: 'object' },
      },
      triggers: {
        type: 'array',
        description: 'How the flow can be started.',
        items: { type: 'object' },
      },
      status: { type: 'string', enum: ['draft', 'active', 'archived'], description: 'Flow lifecycle status (default: draft). Set to "active" to enable execution.' },
      workspaceId: { type: 'string', description: 'Workspace ID (defaults to execution workspace).' },
      flowId: { type: 'string', description: 'Optional existing flow ID for upsert (update if exists).' },
      projectId: { type: 'string', description: 'Default project ID — tasks created by this flow go to this project\'s board. Can be overridden per action node.' },
    },
    required: ['name', 'nodes'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  // The channel the save was issued from is where schedule runs get posted.
  handler: forward('flows-save', (ctx) => compact({ channelId: ctx.execution?.channelId, agentId: ctx.execution?.agentId })),
};

const getFlow: ToolConfig = {
  description:
    'Get a flow by ID — returns the full graph (nodes, edges, triggers) and metadata. Use this to inspect a flow before executing it.',
  parameters: {
    type: 'object',
    properties: {
      flowId: { type: 'string', description: 'The flow ID (e.g., "flow_abc123").' },
    },
    required: ['flowId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: forward('flows-get'),
};

const listFlows: ToolConfig = {
  description:
    'List flows in a workspace, optionally filtered by status (draft, active, archived). Returns flows sorted by most recently updated. Each flow includes flowId, name, description, status, node/edge counts, and timestamps — but NOT the full graph (use get-flow for that).',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'Workspace ID (defaults to execution workspace).' },
      status: {
        type: 'string',
        enum: ['draft', 'active', 'archived'],
        description: 'Filter by flow status. Omit to list all statuses.',
      },
    },
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: forward('flows-list'),
};

const deleteFlow: ToolConfig = {
  description:
    'Delete a flow by ID — permanently removes the flow document (nodes, edges, triggers, and all metadata). Irreversible. Returns { deleted: true } on success. Use list-flows to find flow IDs.',
  parameters: {
    type: 'object',
    properties: {
      flowId: { type: 'string', description: 'The flow ID to delete (e.g., "flow_abc123").' },
    },
    required: ['flowId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: forward('flows-delete'),
};

// =============================================================================
// EXECUTION
// =============================================================================

const executeFlow: ToolConfig = {
  description:
    'Start a new execution of a flow. The engine processes the start node, cascades through non-action nodes (gate, parallel, condition), and creates board tasks for action nodes. Returns the execution, all steps created, and pending task IDs (tasks waiting for agent/human completion). The flow must be in "active" status. Pass projectId to specify which board project the tasks are created on.',
  parameters: {
    type: 'object',
    properties: {
      flowId: { type: 'string', description: 'The flow to execute (must be in "active" status).' },
      projectId: { type: 'string', description: 'Project board ID where action node tasks will be created. If omitted, uses the flow\'s default projectId. Required if the flow has no default project.' },
      triggeredBy: { type: 'string', enum: ['manual', 'schedule', 'webhook', 'event'], description: 'How the execution was triggered (default: manual).' },
      triggerData: { type: 'object', description: 'Optional trigger payload (webhook body, schedule data, etc.). Passed to the start node.' },
      defaultPriority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'], description: 'Default priority for created tasks (default: medium).' },
    },
    required: ['flowId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: forward('executions-start', (ctx) => compact({ agentId: ctx.execution?.agentId })),
};

const advanceFlow: ToolConfig = {
  description:
    'Advance a workflow execution after a task completes. The engine validates the task output against the node\'s output gate artifact schema, marks the step as completed, and cascades to the next nodes (creating new tasks for any new action nodes). If validation fails, the execution is marked as failed and validation errors are returned. Use this when a board task linked to a workflow execution is completed (moved to Review or Done).',
  parameters: {
    type: 'object',
    properties: {
      executionId: {
        type: 'string',
        description: 'The execution ID to advance (e.g., "exec_abc123").',
      },
      taskId: {
        type: 'string',
        description: 'The board task ID that completed. Must match a step in the execution.',
      },
      outputData: {
        type: 'object',
        description: 'The output data produced by the task (the deliverable). Validated against the node\'s output gate artifact schema. If omitted, the engine uses whatever output data is already stored on the step.',
      },
    },
    required: ['executionId', 'taskId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: forward('executions-advance'),
};

const getExecution: ToolConfig = {
  description:
    'Get the status of a workflow execution — returns the execution document, all steps (with node IDs, statuses, task IDs, branch IDs, and output data), a grouped view (trunk steps + per-branch groups with split/join metadata), and a summary (total/completed/running/pending/failed/blocked counts + allCompleted flag). Use this to check progress of a running execution, especially for Split/Join workflows with parallel branches.',
  parameters: {
    type: 'object',
    properties: {
      executionId: { type: 'string', description: 'The execution ID (e.g., "exec_abc123").' },
    },
    required: ['executionId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: forward('executions-get'),
};

const cancelExecution: ToolConfig = {
  description:
    'Cancel a workflow execution — marks it as "cancelled" and sets completedAt. Useful when an execution is stale, contaminated by bugs, or no longer needed. Cannot cancel executions that are already "completed" or "cancelled". Running executions are marked cancelled (in-flight tasks are not killed, but the status is corrected).',
  parameters: {
    type: 'object',
    properties: {
      executionId: {
        type: 'string',
        description: 'The execution ID to cancel (e.g., "exec_abc123").',
      },
      reason: {
        type: 'string',
        description: 'Optional reason for cancellation. Stored in the execution\'s error field. Defaults to "Cancelled by user".',
      },
    },
    required: ['executionId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: forward('executions-cancel'),
};

const listExecutionsTool: ToolConfig = {
  description:
    'List workflow executions in a workspace, optionally filtered by flow and/or status (running, completed, failed, paused, cancelled). Returns executions sorted by most recently started (descending). Each execution includes executionId, flowId, status, startedAt, completedAt, and error (if any).',
  parameters: {
    type: 'object',
    properties: {
      flowId: {
        type: 'string',
        description: 'Filter by flow ID. Omit to list executions across all flows.',
      },
      status: {
        type: 'string',
        enum: ['running', 'completed', 'failed', 'paused', 'cancelled'],
        description: 'Filter by execution status. Omit to list all statuses.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of executions to return (default: 20, max: 200).',
      },
      workspaceId: {
        type: 'string',
        description: 'Workspace ID (defaults to execution workspace).',
      },
    },
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: forward('executions-list'),
};

// =============================================================================
// ARTIFACT MANAGEMENT
// =============================================================================

const createArtifact: ToolConfig = {
  description:
    'Create a new artifact — a named schema definition that types a gate. Artifacts define the shape of data flowing through gates (like TypeScript interfaces or Zod schemas, but simpler). Each property has a name, type, and optional constraints (required, enum, nested properties, array item type). Scopes: global (all workspaces), workspace (only this workspace), flow (only within a specific flow). Returns the created artifact with a generated artifactId.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Machine-readable name (e.g., "Lead", "Email", "Report").' },
      title: { type: 'string', description: 'Human-readable title.' },
      description: { type: 'string', description: 'What this artifact represents.' },
      color: { type: 'string', description: 'Hex color for visual identification (e.g., "#FF5733"). Default: "#5E6AD2".' },
      icon: { type: 'string', description: 'Emoji or icon name for visual identification. Default: "📦".' },
      source: { type: 'string', enum: ['global', 'workspace', 'flow'], description: 'Scope: global (all workspaces), workspace (only this workspace), flow (only within a specific flow). Default: "workspace".' },
      flowId: { type: 'string', description: 'Required when source is "flow" — the flow this artifact belongs to.' },
      schema: {
        type: 'object',
        description: 'The schema definition — shape of data this artifact describes.',
        properties: {
          name: { type: 'string', description: 'Schema name (usually matches the artifact name).' },
          title: { type: 'string', description: 'Human-readable title.' },
          type: { type: 'string', description: 'Top-level type (usually "object"). Default: "object".' },
          properties: { type: 'object', description: 'Named properties with their types and constraints.' },
          strict: { type: 'boolean', description: 'If true, reject data with extra properties not in `properties`. Default: false.' },
          isArray: { type: 'boolean', description: 'If true, the gate carries an array of objects (each matching `properties`) instead of a single object. This is the foundation for Split/Join patterns: a Split node produces an array of artifacts, and a Join node consumes one. Default: false.' },
        },
      },
      workspaceId: { type: 'string', description: 'Workspace ID (defaults to execution workspace).' },
    },
    required: ['name', 'title', 'schema'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: forward('artifacts-create'),
};

const listArtifacts: ToolConfig = {
  description:
    'List artifacts — named schema definitions that gates reference. Optionally filter by scope (global, workspace, flow) or flowId. Returns artifacts sorted by most recently updated. Without filters, returns all artifacts visible to the current workspace (global + workspace-scoped).',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', enum: ['global', 'workspace', 'flow'], description: 'Filter by scope: global (pre-built, all workspaces), workspace (only this workspace), flow (only within a specific flow).' },
      flowId: { type: 'string', description: 'Filter to artifacts belonging to a specific flow (use with source="flow").' },
      workspaceId: { type: 'string', description: 'Workspace ID (defaults to execution workspace).' },
    },
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: forward('artifacts-list'),
};

const updateArtifact: ToolConfig = {
  description:
    'Update an artifact by ID — modify its name, title, description, color, icon, or schema definition. Only the fields you pass are updated; omitted fields are left unchanged. Returns the updated artifact. Use list-artifacts to find artifact IDs.',
  parameters: {
    type: 'object',
    properties: {
      artifactId: { type: 'string', description: 'The artifact ID (e.g., "art_abc123").' },
      name: { type: 'string', description: 'New machine-readable name.' },
      title: { type: 'string', description: 'New human-readable title.' },
      description: { type: 'string', description: 'New description.' },
      color: { type: 'string', description: 'New hex color for visual identification.' },
      icon: { type: 'string', description: 'New emoji or icon name.' },
      schema: {
        type: 'object',
        description: 'New schema definition — replaces the existing schema entirely.',
        properties: {
          name: { type: 'string', description: 'Schema name.' },
          title: { type: 'string', description: 'Human-readable title.' },
          type: { type: 'string', description: 'Top-level type (usually "object").' },
          properties: { type: 'object', description: 'Named properties with their types and constraints.' },
          strict: { type: 'boolean', description: 'If true, reject data with extra properties.' },
          isArray: { type: 'boolean', description: 'If true, the gate carries an array of objects instead of a single object. Used for Split/Join patterns.' },
        },
      },
    },
    required: ['artifactId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: forward('artifacts-update'),
};

const deleteArtifact: ToolConfig = {
  description:
    'Delete an artifact by ID — permanently removes the artifact schema definition. Gates that reference this artifact via schemaId will have dangling references after deletion. Use with caution. Returns { deleted: true } on success. Use list-artifacts to find artifact IDs.',
  parameters: {
    type: 'object',
    properties: {
      artifactId: { type: 'string', description: 'The artifact ID to delete (e.g., "art_abc123").' },
    },
    required: ['artifactId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: forward('artifacts-delete'),
};

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.workflows',
  name: 'Workflows',
  version: '1.0.0',
});

server.tool('-health-check', healthCheck);

server.tool('create-flow', createFlow);
server.tool('get-flow', getFlow);
server.tool('list-flows', listFlows);
server.tool('delete-flow', deleteFlow);

server.tool('execute-flow', executeFlow);
server.tool('advance-flow', advanceFlow);
server.tool('get-execution', getExecution);
server.tool('cancel-execution', cancelExecution);
server.tool('list-executions', listExecutionsTool);

server.tool('create-artifact', createArtifact);
server.tool('list-artifacts', listArtifacts);
server.tool('update-artifact', updateArtifact);
server.tool('delete-artifact', deleteArtifact);

// =============================================================================
// START
// =============================================================================

async function main(): Promise<void> {
  console.error('🚀 Starting Workflows MCA...');
  await server.start();
  console.error('✅ Workflows MCA ready');
}

main().catch((error) => {
  console.error('❌ [Workflows MCA] Fatal error:', error);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.error('📴 Shutting down Workflows MCA...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('📴 Shutting down Workflows MCA...');
  process.exit(0);
});
