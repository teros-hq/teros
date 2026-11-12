/**
 * workflows actions — mca.teros.workflows, APIfied.
 *
 * The flows / executions / execution_steps / artifacts collections are shared
 * platform data: the backend already runs the WorkflowEngine against them for
 * schedule / webhook / event triggers and board task completion
 * (ActionBridgeManager), so the MCA cannot own them in a per-installation
 * store. The logic here used to run inside mca.teros.workflows with its own
 * MongoClient (and a local WorkflowEngine); it now runs in the backend and the
 * MCA is a thin client (datastore-isolation, P1b).
 *
 * Tenancy model — identical for every action:
 *   - The workspace is derived from the verified token, never from the body:
 *     `apps.findOne({ appId: ctx.appId }).ownerId` must name an existing
 *     workspace, otherwise 403. Any `workspaceId` the caller sends is ignored.
 *   - Every by-ID operation filters by `{ <id>, workspaceId }`: a document of
 *     another workspace answers NOT_FOUND (its existence is not revealed).
 *     This closes the cross-tenant hole the direct-Mongo MCA had (it looked
 *     flows/executions/artifacts up by ID alone).
 *   - Global artifacts (`source: 'global'`, no workspaceId) are readable by
 *     everyone and immutable through this path.
 *
 * Attribution — known limitation: `ctx.userId` is the workspace OWNER (the
 * callback token identifies the container, which is per-app, not the end user
 * who triggered the tool). `createdBy` and the schedule's `userId` therefore
 * record the owner. Per-end-user attribution needs a per-request identity on
 * the callback, which the token does not carry today.
 *
 * Result shapes are EXACTLY what the former MCA tools returned (the Flow*
 * windows parse them), and error codes/messages are preserved so the thin
 * client can rebuild the `{error:true, code, message, suggestion}` payload
 * the UI's parseFlowError expects.
 */

import type { Db, Filter } from 'mongodb';
import { z, type ZodTypeAny } from 'zod';
import {
  generateArtifactId,
  generateEdgeId,
  generateFlowId,
  generateGateId,
  generateNodeId,
  generateTriggerId,
  getArtifactsCollection,
  getExecutionsCollection,
  getFlowsCollection,
} from '@teros/workflows/models';
import type {
  Artifact,
  ArtifactSchema,
  Execution,
  ExecutionStatus,
  Flow,
  FlowStatus,
  Gate,
  NodeType,
  Trigger,
  TriggerType,
  WorkflowEdge,
  WorkflowNode,
} from '@teros/workflows/models';
import { WorkflowError } from '@teros/workflows/engine';
import type { WorkflowEngine } from '@teros/workflows/engine';
import type { WsHandler, WsHandlerContext } from '@teros/shared';
import { createSyncFlowTriggersHandler } from '../handlers/domains/automate/sync-flow-triggers';
import { getMcaActionDeps, McaActionError, type McaActionCapability, type McaActionCtx } from './index';

const MCA_ID = 'mca.teros.workflows';

// =============================================================================
// Errors
// =============================================================================

/** Domain error (400 unless stated) with the same code/message/suggestion the MCA tools used. */
function fail(code: string, message: string, suggestion?: string, status = 400): never {
  throw new McaActionError(code, message, status, suggestion);
}

function notFound(code: string, message: string, suggestion?: string): never {
  return fail(code, message, suggestion, 404);
}

/** Engine errors keep their own code (FLOW_NOT_ACTIVE, EXECUTION_NOT_FOUND, ...). */
async function withEngineErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorkflowError) {
      const status = err.code.endsWith('_NOT_FOUND') ? 404 : 400;
      throw new McaActionError(err.code, err.message, status, err.suggestion);
    }
    throw err;
  }
}

// =============================================================================
// Input validation (same zod schemas the MCA tools validated with)
// =============================================================================

function validateInput<T extends ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.errors[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : '<input>';
    return fail(
      'INVALID_INPUT',
      `Invalid input at "${path}": ${issue.message}`,
      'Check the tool description for the expected shape.',
    );
  }
  return parsed.data;
}

const GateSchema = z.object({
  gateId: z.string().optional(),
  label: z.string().optional(),
  schemaId: z.string().nullable().default(null),
  mode: z.enum(['passthrough', 'find', 'create']).default('passthrough'),
  allowModifying: z.boolean().nullish(),
});

const NodeSchema = z.object({
  nodeId: z.string().optional(),
  type: z.enum(['start', 'action', 'end', 'function', 'pin', 'integration', 'split', 'join']),
  label: z.string(),
  description: z.string().default(''),
  instructions: z.string().default(''),
  role: z.string().default(''),
  color: z.string().default(''),
  direction: z.string().default('right'),
  inputs: z.array(GateSchema).default([]),
  outputs: z.array(GateSchema).default([]),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  data: z.record(z.unknown()).nullish(),
  projectId: z.string().optional(),
});

const EdgeSchema = z.object({
  edgeId: z.string().optional(),
  flowId: z.string().optional(),
  label: z.string().optional(),
  outputNodeId: z.string(),
  outputId: z.string(),
  inputNodeId: z.string(),
  inputId: z.string(),
});

const TriggerSchema = z.object({
  triggerId: z.string().optional(),
  type: z.enum(['manual', 'schedule', 'webhook', 'event']),
  config: z.record(z.unknown()).default({}),
});

const SaveFlowSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  nodes: z.array(NodeSchema).min(1),
  edges: z.array(EdgeSchema).default([]),
  triggers: z.array(TriggerSchema).default([]),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  flowId: z.string().optional(),
  projectId: z.string().optional(),
  /** Channel the save was issued from — the scheduler posts schedule runs there. */
  channelId: z.string().optional(),
  /** Executing agent, forwarded by the MCA; attributes the created starters. */
  agentId: z.string().optional(),
});

const FlowIdSchema = z.object({ flowId: z.string().min(1) });

const ListFlowsSchema = z.object({
  status: z.enum(['draft', 'active', 'archived']).optional(),
});

const StartExecutionSchema = z.object({
  flowId: z.string().min(1),
  projectId: z.string().optional(),
  triggeredBy: z.enum(['manual', 'schedule', 'webhook', 'event']).default('manual'),
  triggerData: z.any().optional(),
  defaultPriority: z.enum(['urgent', 'high', 'medium', 'low']).default('medium'),
  agentId: z.string().optional(),
});

const AdvanceExecutionSchema = z.object({
  executionId: z.string().min(1),
  taskId: z.string().min(1),
  outputData: z.any().optional(),
});

const ExecutionIdSchema = z.object({ executionId: z.string().min(1) });

const CancelExecutionSchema = z.object({
  executionId: z.string().min(1),
  reason: z.string().optional(),
});

const ListExecutionsSchema = z.object({
  flowId: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'paused', 'cancelled']).optional(),
  limit: z.number().int().min(1).max(200).default(20),
});

const ArtifactPropertySchema: z.ZodType<unknown> = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']),
  required: z.boolean().optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  properties: z.record(z.lazy(() => ArtifactPropertySchema)).optional(),
  items: z.lazy(() => ArtifactPropertySchema).optional(),
  description: z.string().optional(),
  strict: z.boolean().optional(),
  // UI metadata (used by the output form)
  label: z.string().optional(),
  placeholder: z.string().optional(),
  defaultValue: z.any().optional(),
  hint: z.string().optional(),
  format: z.string().optional(),
});

const ArtifactSchemaField = z.object({
  name: z.string(),
  title: z.string(),
  type: z.string().default('object'),
  properties: z.record(ArtifactPropertySchema),
  strict: z.boolean().optional(),
  isArray: z.boolean().optional(),
});

const ListArtifactsSchema = z.object({
  source: z.enum(['global', 'workspace', 'flow']).optional(),
  flowId: z.string().optional(),
});

const CreateArtifactSchema = z.object({
  name: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  color: z.string().default('#5E6AD2'),
  icon: z.string().default('📦'),
  source: z.enum(['global', 'workspace', 'flow']).default('workspace'),
  flowId: z.string().optional(),
  schema: ArtifactSchemaField,
});

const UpdateArtifactSchema = z.object({
  artifactId: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
  schema: ArtifactSchemaField.optional(),
});

const ArtifactIdSchema = z.object({ artifactId: z.string().min(1) });

// =============================================================================
// Tenancy
// =============================================================================

interface Tenant {
  /** The workspace every query is scoped to. */
  wsId: string;
  /** Workspace owner — used for attribution (see the header comment). */
  userId: string;
}

const FORBIDDEN_MSG = 'workflows actions require a workspace-owned app';

/**
 * Resolve the calling app's workspace from the verified token. The body is
 * never consulted. Fails closed (403) when the app is unknown, is not owned
 * by a workspace, or the workspace no longer exists.
 */
async function requireTenant(db: Db, ctx: McaActionCtx): Promise<Tenant> {
  if (!ctx.appId) return fail('FORBIDDEN', FORBIDDEN_MSG, undefined, 403);
  const app = await db.collection('apps').findOne({ appId: ctx.appId });
  const wsId = app?.ownerId;
  if (!app || typeof wsId !== 'string' || wsId === '') return fail('FORBIDDEN', FORBIDDEN_MSG, undefined, 403);
  const workspace = await db.collection('workspaces').findOne({ workspaceId: wsId });
  if (!workspace) return fail('FORBIDDEN', FORBIDDEN_MSG, undefined, 403);
  const userId = ctx.userId ?? (typeof workspace.ownerId === 'string' ? workspace.ownerId : undefined);
  if (!userId) return fail('FORBIDDEN', FORBIDDEN_MSG, undefined, 403);
  return { wsId, userId };
}

/** Load a flow owned by the tenant; a foreign or missing flow is NOT_FOUND. */
async function findOwnedFlow(db: Db, wsId: string, flowId: string): Promise<Flow | null> {
  const doc = await getFlowsCollection(db).findOne({ flowId, workspaceId: wsId } as Filter<Flow>);
  return doc ? stripId(doc) : null;
}

/** Load an execution owned by the tenant; a foreign or missing one is NOT_FOUND. */
async function findOwnedExecution(db: Db, wsId: string, executionId: string): Promise<Execution | null> {
  const doc = await getExecutionsCollection(db).findOne({ executionId, workspaceId: wsId } as Filter<Execution>);
  return doc ? stripId(doc) : null;
}

function stripId<T extends { _id?: unknown }>(doc: T): Omit<T, '_id'> {
  const { _id: _ignored, ...rest } = doc;
  return rest;
}

/** Engine owned by the backend (same instance the trigger/board paths use). */
function requireEngine(projectId: string): WorkflowEngine {
  const manager = getMcaActionDeps().actionBridgeManager;
  if (!manager) {
    return fail('UNAVAILABLE', 'Workflow engine is not available on this backend', undefined, 503);
  }
  // Known gap (pre-existing in the trigger path): engines are cached per
  // projectId with the backend's default priority and no per-call identity
  // (userId/agentId/channelId), so `defaultPriority` and `agentId` of a
  // start request cannot be honoured per execution.
  return manager.getEngine(projectId);
}

// =============================================================================
// Date helpers — replicate each former tool's exact serialization
// =============================================================================

function isoOrString(d: Date | string | undefined): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

function isoOrUndefined(d: Date | undefined): string | undefined {
  return d instanceof Date ? d.toISOString() : d === undefined ? undefined : new Date(d).toISOString();
}

function isoOrNull(d: Date | undefined): string | null {
  return d instanceof Date ? d.toISOString() : null;
}

function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d);
}

// =============================================================================
// Trigger sync — Automate owns a flow's triggers
// =============================================================================
//
// A flow's schedule / webhook / event triggers are Automate `start-flow`
// starters owned by the flow. The former MCA called the WS domain action
// `automate.sync-flow-triggers` after every save (one idempotent reconcile)
// and with `remove: true` on delete. We reuse that handler's exact reconcile
// IN-PROCESS. The legacy per-trigger Flow*Services are not used here.

type FlowTriggerInput =
  | { type: 'schedule'; cronExpression: string; timezone?: string }
  | { type: 'webhook' }
  | { type: 'event'; topic: string; rules?: Record<string, unknown>[] };

/** Same mapping the former create-flow applied before calling Automate. */
function toSyncTriggers(triggers: Trigger[]): FlowTriggerInput[] {
  const out: FlowTriggerInput[] = [];
  for (const t of triggers) {
    const cfg = (t.config ?? {}) as Record<string, unknown>;
    if (t.type === 'schedule' && typeof cfg.cronExpression === 'string') {
      out.push({
        type: 'schedule',
        cronExpression: cfg.cronExpression,
        timezone: typeof cfg.timezone === 'string' ? cfg.timezone : undefined,
      });
    } else if (t.type === 'webhook') {
      out.push({ type: 'webhook' });
    } else if (t.type === 'event' && typeof cfg.topic === 'string') {
      out.push({
        type: 'event',
        topic: cfg.topic,
        rules: Array.isArray(cfg.rules) ? (cfg.rules as Record<string, unknown>[]) : undefined,
      });
    }
  }
  return out;
}

let syncHandlerCache: WsHandler | undefined;

function requireSyncHandler(db: Db): WsHandler {
  if (syncHandlerCache) return syncHandlerCache;
  const deps = getMcaActionDeps();
  if (!deps.automateModel || !deps.workspaceService) {
    throw new McaActionError('UNAVAILABLE', 'Automate is not available for flow trigger sync', 503);
  }
  syncHandlerCache = createSyncFlowTriggersHandler(deps.automateModel, deps.workspaceService, db);
  return syncHandlerCache;
}

/**
 * Minimal handler context: the token's user (the workspace owner) acts; when
 * the MCA forwarded the executing agent, it is the actor (starter attribution).
 */
function syncCtx(userId: string, agentId?: string): WsHandlerContext {
  return {
    userId,
    sessionId: 'mca-actions',
    ip: '127.0.0.1',
    ...(agentId ? { actor: { kind: 'agent' as const, agentId } } : {}),
  };
}

interface SyncArgs {
  db: Db;
  wsId: string;
  flow: Flow;
  projectId: string;
  userId: string;
  agentId?: string;
  warnings: string[];
}

/** Reconcile the flow's starters. Returns the webhook URL when one was minted. Non-fatal. */
async function syncTriggersWithAutomate({ db, wsId, flow, projectId, userId, agentId, warnings }: SyncArgs): Promise<string | undefined> {
  if (!projectId) return undefined; // as before: without a project there is nothing to attach triggers to
  try {
    const handler = requireSyncHandler(db);
    const synced = (await handler(syncCtx(userId, agentId), {
      workspaceId: wsId,
      flowId: flow.flowId,
      projectId,
      name: flow.name,
      active: flow.status === 'active',
      triggers: toSyncTriggers(flow.triggers),
    })) as { webhookUrl?: string } | undefined;
    return synced?.webhookUrl;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[workflows actions] Failed to sync triggers of flow ${flow.flowId} with Automate:`, msg);
    warnings.push(`Failed to sync triggers with Automate: ${msg}`);
    return undefined;
  }
}

/** Delete every starter the flow owns. Non-fatal. */
async function removeTriggersWithAutomate(args: { db: Db; wsId: string; flowId: string; userId: string; warnings: string[] }): Promise<void> {
  const { db, wsId, flowId, userId, warnings } = args;
  try {
    const handler = requireSyncHandler(db);
    await handler(syncCtx(userId), { workspaceId: wsId, flowId, remove: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[workflows actions] Failed to remove Automate triggers of flow ${flowId}:`, msg);
    warnings.push(`Failed to remove triggers in Automate: ${msg}`);
  }
}

// =============================================================================
// Capability
// =============================================================================

export const workflowsCapability: McaActionCapability = {
  mcaId: MCA_ID,
  actions: {
    /**
     * Liveness of the action channel. Touches no tenant data, so it is the one
     * action that does not resolve the workspace (a container's health check
     * must not flip to not_ready over tenancy).
     */
    async ping() {
      return { ok: true };
    },

    // -------------------------------------------------------------------------
    // Flows
    // -------------------------------------------------------------------------

    /** Former list-flows. Scope: { workspaceId, status? }. */
    async 'flows-list'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(ListFlowsSchema, body);
      const query: Record<string, unknown> = { workspaceId: wsId };
      if (input.status) query.status = input.status;
      const flows = await getFlowsCollection(db).find(query as Filter<Flow>).sort({ updatedAt: -1 }).toArray();
      return {
        flows: flows.map((f) => ({
          flowId: f.flowId,
          workspaceId: f.workspaceId,
          name: f.name,
          description: f.description,
          status: f.status,
          projectId: f.projectId ?? null,
          nodeCount: f.nodes?.length ?? 0,
          edgeCount: f.edges?.length ?? 0,
          triggerCount: f.triggers?.length ?? 0,
          createdBy: f.createdBy,
          createdAt: isoOrString(f.createdAt),
          updatedAt: isoOrString(f.updatedAt),
        })),
        count: flows.length,
        nextCursor: undefined,
      };
    },

    /** Former get-flow. Scope: { flowId, workspaceId }. */
    async 'flows-get'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(FlowIdSchema, body);
      const flow = await findOwnedFlow(db, wsId, input.flowId);
      if (!flow) {
        return notFound('NOT_FOUND', `Flow "${input.flowId}" not found.`, 'Use list-flows to find available flow IDs.');
      }
      return {
        flowId: flow.flowId,
        workspaceId: flow.workspaceId,
        name: flow.name,
        description: flow.description,
        status: flow.status,
        projectId: flow.projectId ?? null,
        nodes: flow.nodes,
        edges: flow.edges,
        triggers: flow.triggers,
        createdBy: flow.createdBy,
        createdAt: isoOrString(flow.createdAt),
        updatedAt: isoOrString(flow.updatedAt),
      };
    },

    /**
     * Former create-flow (create or upsert by flowId). Scope: an existing
     * flowId must belong to the workspace (else NOT_FOUND — no hijack via
     * upsert); the write itself filters { flowId, workspaceId }.
     */
    async 'flows-save'(ctx, db, body) {
      const { wsId, userId } = await requireTenant(db, ctx);
      const input = validateInput(SaveFlowSchema, body);

      // Validate: must have at least one start node
      if (!input.nodes.some((n) => n.type === 'start')) {
        return fail(
          'NO_START_NODE',
          'Flow must include at least one node with type "start".',
          'Add a start node — it is the entry point for executions.',
        );
      }

      const flowId = input.flowId || generateFlowId();

      // When updating an existing flow, it must be ours; preserve its createdAt.
      const now = new Date();
      let createdAt = now;
      if (input.flowId) {
        const existingAny = await getFlowsCollection(db).findOne({ flowId } as Filter<Flow>);
        if (existingAny) {
          if (existingAny.workspaceId !== wsId) {
            return notFound('NOT_FOUND', `Flow "${flowId}" not found.`, 'Use list-flows to find available flow IDs.');
          }
          createdAt = toDate(existingAny.createdAt);
        }
      }

      // `mode` is not part of the Gate model but the former MCA persisted it
      // and the editor round-trips it, so the stored shape is kept unchanged.
      type StoredGate = Gate & { mode: z.infer<typeof GateSchema>['mode'] };
      const toGate = (g: z.infer<typeof GateSchema>): StoredGate => ({
        gateId: g.gateId || generateGateId(),
        label: g.label,
        schemaId: g.schemaId ?? null,
        mode: g.mode,
        allowModifying: g.allowModifying ?? undefined,
      });

      const nodes: WorkflowNode[] = input.nodes.map((n) => ({
        nodeId: n.nodeId || generateNodeId(),
        type: n.type as NodeType,
        label: n.label,
        description: n.description,
        instructions: n.instructions,
        role: n.role,
        color: n.color,
        direction: n.direction,
        inputs: n.inputs.map(toGate),
        outputs: n.outputs.map(toGate),
        position: n.position,
        data: n.data ?? undefined,
        projectId: n.projectId,
      }));

      const edges: WorkflowEdge[] = input.edges.map((e) => ({
        edgeId: e.edgeId || generateEdgeId(),
        flowId,
        label: e.label,
        outputNodeId: e.outputNodeId,
        outputId: e.outputId,
        inputNodeId: e.inputNodeId,
        inputId: e.inputId,
      }));

      const triggers: Trigger[] = input.triggers.map((t) => ({
        triggerId: t.triggerId || generateTriggerId(),
        type: t.type as TriggerType,
        config: t.config,
      }));

      const flow: Flow = {
        flowId,
        workspaceId: wsId,
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        nodes,
        edges,
        triggers,
        status: input.status as FlowStatus,
        createdBy: userId, // workspace owner — see header comment
        createdAt,
        updatedAt: now,
      };

      await getFlowsCollection(db).replaceOne({ flowId, workspaceId: wsId } as Filter<Flow>, flow, { upsert: true });

      const warnings: string[] = [];
      const webhookUrl = await syncTriggersWithAutomate({
        db,
        wsId,
        flow,
        projectId: flow.projectId ?? input.projectId ?? '',
        userId,
        agentId: input.agentId,
        warnings,
      });

      return {
        flowId: flow.flowId,
        name: flow.name,
        description: flow.description,
        status: flow.status,
        projectId: flow.projectId ?? null,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        triggerCount: triggers.length,
        createdAt: flow.createdAt.toISOString(),
        // Shown once: the URL external systems POST to for a webhook trigger.
        ...(webhookUrl ? { webhookUrl } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },

    /** Former delete-flow. Scope: { flowId, workspaceId } (checked before cancelling triggers). */
    async 'flows-delete'(ctx, db, body) {
      const { wsId, userId } = await requireTenant(db, ctx);
      const input = validateInput(FlowIdSchema, body);

      const flow = await findOwnedFlow(db, wsId, input.flowId);
      if (!flow) {
        return notFound(
          'NOT_FOUND',
          `Flow "${input.flowId}" not found — nothing to delete.`,
          'Use list-flows to find available flow IDs.',
        );
      }

      // Remove the Automate starters this flow owns (its triggers) first (non-fatal).
      const warnings: string[] = [];
      await removeTriggersWithAutomate({ db, wsId, flowId: flow.flowId, userId, warnings });

      const result = await getFlowsCollection(db).deleteOne({ flowId: input.flowId, workspaceId: wsId } as Filter<Flow>);
      if (result.deletedCount === 0) {
        return notFound(
          'NOT_FOUND',
          `Flow "${input.flowId}" not found — nothing to delete.`,
          'Use list-flows to find available flow IDs.',
        );
      }

      return { flowId: input.flowId, deleted: true };
    },

    // -------------------------------------------------------------------------
    // Executions (engine runs in the backend)
    // -------------------------------------------------------------------------

    /** Former execute-flow. Scope: flow { flowId, workspaceId }; the execution inherits flow.workspaceId. */
    async 'executions-start'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(StartExecutionSchema, body);

      const flow = await findOwnedFlow(db, wsId, input.flowId);
      if (!flow) {
        return notFound(
          'FLOW_NOT_FOUND',
          `Flow not found: ${input.flowId}`,
          'Make sure the flow ID is correct and the flow has not been deleted.',
        );
      }
      const effectiveProjectId = input.projectId ?? flow.projectId;
      if (!effectiveProjectId) {
        return fail(
          'NO_PROJECT_ID',
          'No project ID provided and the flow has no default project.',
          'Either pass a projectId when executing, or set a default project on the flow in the editor.',
        );
      }

      const engine = requireEngine(effectiveProjectId);
      const result = await withEngineErrors(() =>
        engine.startExecution(input.flowId, input.triggeredBy as TriggerType, input.triggerData),
      );

      return {
        executionId: result.execution.executionId,
        flowId: result.execution.flowId,
        status: result.execution.status,
        triggeredBy: result.execution.triggeredBy,
        startedAt: toDate(result.execution.startedAt).toISOString(),
        steps: result.steps.map((s) => ({
          stepId: s.stepId,
          nodeId: s.nodeId,
          status: s.status,
          taskId: s.taskId,
        })),
        pendingTaskIds: result.pendingTaskIds,
      };
    },

    /** Former advance-flow. Scope: execution { executionId, workspaceId } before the engine is touched. */
    async 'executions-advance'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(AdvanceExecutionSchema, body);

      const execution = await findOwnedExecution(db, wsId, input.executionId);
      if (!execution) {
        // Same code/message the engine itself raises, so callers see no difference.
        return notFound(
          'EXECUTION_NOT_FOUND',
          `Execution not found: ${input.executionId}.`,
          'Check that the execution ID is correct — it may have been deleted or expired.',
        );
      }

      const engine = requireEngine(execution.flowSnapshot?.projectId ?? '');
      const result = await withEngineErrors(() =>
        engine.advanceExecution(input.executionId, input.taskId, input.outputData),
      );

      return {
        execution: {
          executionId: result.execution.executionId,
          flowId: result.execution.flowId,
          status: result.execution.status,
          currentNodes: result.execution.currentNodes,
          completedAt: isoOrUndefined(result.execution.completedAt),
          error: result.execution.error,
        },
        completedStep: {
          stepId: result.completedStep.stepId,
          nodeId: result.completedStep.nodeId,
          status: result.completedStep.status,
          taskId: result.completedStep.taskId,
          outputData: result.completedStep.outputData,
          error: result.completedStep.error,
        },
        newSteps: result.newSteps.map((s) => ({
          stepId: s.stepId,
          nodeId: s.nodeId,
          status: s.status,
          taskId: s.taskId,
        })),
        pendingTaskIds: result.pendingTaskIds,
        validationErrors: result.validationErrors,
      };
    },

    /** Former get-execution. Scope: execution { executionId, workspaceId } before the engine is touched. */
    async 'executions-get'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(ExecutionIdSchema, body);

      const owned = await findOwnedExecution(db, wsId, input.executionId);
      if (!owned) {
        return notFound(
          'EXECUTION_NOT_FOUND',
          `Execution not found: ${input.executionId}.`,
          'Check that the execution ID is correct — it may have been deleted or expired.',
        );
      }

      const engine = requireEngine(owned.flowSnapshot?.projectId ?? '');
      const result = await withEngineErrors(() => engine.getExecutionStatus(input.executionId));

      const steps = result.steps.map((s) => ({
        stepId: s.stepId,
        nodeId: s.nodeId,
        status: s.status,
        taskId: s.taskId,
        branchId: s.branchId,
        arrivedBranchIds: s.arrivedBranchIds,
        expectedCount: s.expectedCount,
        inputData: s.inputData,
        outputData: s.outputData,
        startedAt: isoOrUndefined(s.startedAt),
        completedAt: isoOrUndefined(s.completedAt),
        error: s.error,
      }));

      // Grouped view: trunk steps (no branchId) + per-branch groups
      const trunkSteps = steps.filter((s) => s.branchId === undefined);
      const branchIds = [...new Set(steps.map((s) => s.branchId).filter((b): b is string => b !== undefined))];
      const branchGroups = branchIds.map((bid) => ({
        branchId: bid,
        splitOrigin: result.execution.splitOrigins?.[bid],
        steps: steps.filter((s) => s.branchId === bid),
      }));

      const flow = result.execution.flowSnapshot;
      const splitNodes =
        flow?.nodes.filter((n) => n.type === 'split').map((n) => ({ nodeId: n.nodeId, label: n.label })) ?? [];
      const joinNodes =
        flow?.nodes.filter((n) => n.type === 'join').map((n) => ({ nodeId: n.nodeId, label: n.label })) ?? [];

      return {
        execution: {
          executionId: result.execution.executionId,
          flowId: result.execution.flowId,
          status: result.execution.status,
          triggeredBy: result.execution.triggeredBy,
          currentNodes: result.execution.currentNodes,
          startedAt: toDate(result.execution.startedAt).toISOString(),
          completedAt: isoOrUndefined(result.execution.completedAt),
          error: result.execution.error,
          splitBranches: result.execution.splitBranches,
          splitOrigins: result.execution.splitOrigins,
        },
        steps,
        grouped: {
          trunk: trunkSteps,
          branches: branchGroups,
          splitNodes,
          joinNodes,
        },
        summary: result.summary,
      };
    },

    /** Former cancel-execution. Scope: { executionId, workspaceId } on both the read and the update. */
    async 'executions-cancel'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(CancelExecutionSchema, body);

      const col = getExecutionsCollection(db);
      const scope = { executionId: input.executionId, workspaceId: wsId } as Filter<Execution>;
      const exec = await col.findOne(scope);
      if (!exec) {
        return notFound(
          'NOT_FOUND',
          `Execution "${input.executionId}" not found.`,
          'Use list-executions to find available execution IDs.',
        );
      }

      if (exec.status === 'completed' || exec.status === 'cancelled') {
        return fail(
          'ALREADY_TERMINAL',
          `Execution "${input.executionId}" is already ${exec.status} — cannot cancel.`,
          'Only running, paused, or failed executions can be cancelled.',
        );
      }

      const previousStatus = exec.status;
      const now = new Date();
      await col.updateOne(scope, {
        $set: {
          status: 'cancelled' as ExecutionStatus,
          error: input.reason?.trim() || 'Cancelled by user',
          completedAt: now,
          updatedAt: now,
        },
      });

      const updated = await col.findOne(scope);
      if (!updated) {
        return notFound(
          'NOT_FOUND',
          `Execution "${input.executionId}" not found.`,
          'Use list-executions to find available execution IDs.',
        );
      }

      return {
        executionId: updated.executionId,
        status: updated.status,
        previousStatus,
        completedAt: isoOrUndefined(updated.completedAt),
      };
    },

    /** Former list-executions. Scope: { workspaceId, flowId?, status? }, limit 1..200 (default 20). */
    async 'executions-list'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(ListExecutionsSchema, body);

      const query: Record<string, unknown> = { workspaceId: wsId };
      if (input.flowId) query.flowId = input.flowId;
      if (input.status) query.status = input.status;

      const executions = await getExecutionsCollection(db)
        .find(query as Filter<Execution>)
        .sort({ startedAt: -1 })
        .limit(input.limit)
        .toArray();

      return {
        executions: executions.map((e) => ({
          executionId: e.executionId,
          flowId: e.flowId,
          status: e.status,
          triggeredBy: e.triggeredBy,
          startedAt: isoOrString(e.startedAt),
          completedAt: isoOrNull(e.completedAt),
          error: e.error ?? null,
        })),
        count: executions.length,
      };
    },

    // -------------------------------------------------------------------------
    // Artifacts
    // -------------------------------------------------------------------------

    /**
     * Former list-artifacts. Scope: { $or: [{ workspaceId }, { source: 'global' }], source?, flowId? }.
     * A foreign flowId cannot leak anything: flow-scoped artifacts carry the
     * owning workspaceId, and globals have no flowId.
     */
    async 'artifacts-list'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(ListArtifactsSchema, body);

      const query: Record<string, unknown> = { $or: [{ workspaceId: wsId }, { source: 'global' }] };
      if (input.source) query.source = input.source;
      if (input.flowId) query.flowId = input.flowId;

      const artifacts = await getArtifactsCollection(db)
        .find(query as Filter<Artifact>)
        .sort({ updatedAt: -1 })
        .toArray();

      return {
        artifacts: artifacts.map((a) => ({
          artifactId: a.artifactId,
          name: a.name,
          title: a.title,
          description: a.description,
          source: a.source,
          color: a.color,
          icon: a.icon,
          flowId: a.flowId,
          schema: a.schema,
          createdAt: toDate(a.createdAt).toISOString(),
          updatedAt: toDate(a.updatedAt).toISOString(),
        })),
        count: artifacts.length,
      };
    },

    /**
     * Former create-artifact. Scope: always written with the tenant's
     * workspaceId; `source: 'global'` is refused; a flow-scoped artifact
     * requires a flow owned by the tenant.
     */
    async 'artifacts-create'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(CreateArtifactSchema, body);

      if (input.source === 'global') {
        return fail(
          'BAD_REQUEST',
          'Global artifacts cannot be created through this action.',
          'Use source "workspace" or "flow".',
        );
      }
      if (input.source === 'flow') {
        if (!input.flowId) {
          return fail(
            'MISSING_FLOW_ID',
            'Artifacts with source "flow" must include a flowId.',
            'Provide the flowId of the flow this artifact belongs to.',
          );
        }
        const flow = await findOwnedFlow(db, wsId, input.flowId);
        if (!flow) {
          return notFound('NOT_FOUND', `Flow "${input.flowId}" not found.`, 'Use list-flows to find available flow IDs.');
        }
      }

      const now = new Date();
      const artifact: Artifact = {
        artifactId: generateArtifactId(),
        workspaceId: wsId,
        flowId: input.source === 'flow' ? input.flowId : undefined,
        source: input.source,
        name: input.name,
        title: input.title,
        description: input.description,
        color: input.color,
        icon: input.icon,
        schema: input.schema as ArtifactSchema,
        createdAt: now,
        updatedAt: now,
      };

      await getArtifactsCollection(db).insertOne(artifact);

      return {
        artifactId: artifact.artifactId,
        name: artifact.name,
        title: artifact.title,
        description: artifact.description,
        source: artifact.source,
        color: artifact.color,
        icon: artifact.icon,
        schema: artifact.schema,
        createdAt: artifact.createdAt.toISOString(),
      };
    },

    /** Former update-artifact. Scope: { artifactId, workspaceId } — globals are immutable here. */
    async 'artifacts-update'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(UpdateArtifactSchema, body);

      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.title !== undefined) updates.title = input.title;
      if (input.description !== undefined) updates.description = input.description;
      if (input.color !== undefined) updates.color = input.color;
      if (input.icon !== undefined) updates.icon = input.icon;
      if (input.schema !== undefined) updates.schema = input.schema;

      if (Object.keys(updates).length === 0) {
        return fail(
          'NO_UPDATES',
          'No fields provided to update. Pass at least one of: name, title, description, color, icon, schema.',
        );
      }

      const updated = await getArtifactsCollection(db).findOneAndUpdate(
        { artifactId: input.artifactId, workspaceId: wsId } as Filter<Artifact>,
        { $set: { ...updates, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!updated) {
        return notFound(
          'NOT_FOUND',
          `Artifact "${input.artifactId}" not found.`,
          'Use list-artifacts to find available artifact IDs.',
        );
      }

      return {
        artifactId: updated.artifactId,
        name: updated.name,
        title: updated.title,
        description: updated.description,
        source: updated.source,
        color: updated.color,
        icon: updated.icon,
        schema: updated.schema,
        updatedAt: toDate(updated.updatedAt).toISOString(),
      };
    },

    /** Former delete-artifact. Scope: { artifactId, workspaceId } — globals are immutable here. */
    async 'artifacts-delete'(ctx, db, body) {
      const { wsId } = await requireTenant(db, ctx);
      const input = validateInput(ArtifactIdSchema, body);

      const result = await getArtifactsCollection(db).deleteOne({
        artifactId: input.artifactId,
        workspaceId: wsId,
      } as Filter<Artifact>);
      if (result.deletedCount === 0) {
        return notFound(
          'NOT_FOUND',
          `Artifact "${input.artifactId}" not found — nothing to delete.`,
          'Use list-artifacts to find available artifact IDs.',
        );
      }

      return { artifactId: input.artifactId, deleted: true };
    },
  },
};
