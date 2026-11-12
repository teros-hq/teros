/**
 * Workflow Model Types
 *
 * TypeScript interfaces for the Teros Workflows MongoDB collections:
 * - artifacts: Artifact documents (named schema definitions for gates)
 * - flows: Flow documents (directed graphs of nodes + edges)
 * - executions: Execution documents (single runs of a flow)
 * - execution_steps: ExecutionStep documents (individual node executions within an Execution)
 *
 * Embedded types (not separate collections):
 * - Node: A unit of work with input/output gates, role, and instructions
 * - Edge: A connection between an output gate and an input gate
 * - Gate: A typed port on a node, referencing an Artifact via schemaId
 * - Trigger: What starts a flow execution
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

// ============================================================================
// ARTIFACT — Named schema definition (MongoDB collection: artifacts)
// ============================================================================

/**
 * Artifact scope — where the artifact is visible.
 *
 * | Scope     | Visible to                                        |
 * |-----------|---------------------------------------------------|
 * | global    | All workspaces (pre-built: Lead, Email, Report…)  |
 * | workspace | Only within the workspace that created it         |
 * | flow      | Only within the flow that created it              |
 */
export type ArtifactScope = 'global' | 'workspace' | 'flow';

/**
 * Artifact — A named schema definition that types a gate.
 *
 * Artifacts define the shape of data flowing through gates. They are NOT
 * stored data objects — they are schema definitions (like TypeScript interfaces
 * or Zod schemas, but simpler).
 *
 * Stored in the `artifacts` MongoDB collection.
 *
 * Example artifacts: "Lead", "Lead Modified", "Email", "Report"
 */
export interface Artifact {
  /** Unique identifier (e.g., "art_abc123def456") */
  artifactId: string;

  /** Workspace this artifact belongs to (null/undefined for global artifacts) */
  workspaceId?: string;

  /** Flow this artifact belongs to (null/undefined for global/workspace artifacts) */
  flowId?: string;

  /** Scope: global, workspace, or flow-specific */
  source: ArtifactScope;

  /** Machine-readable name (e.g., "Lead", "Email", "Report") */
  name: string;

  /** Human-readable title */
  title: string;

  /** Description of what this artifact represents */
  description: string;

  /** Color for visual identification in the editor (hex, e.g. "#FF5733") */
  color: string;

  /** Icon for visual identification (emoji or icon name) */
  icon: string;

  /** Schema definition — the shape of data this artifact describes */
  schema: ArtifactSchema;

  /** Creation timestamp */
  createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;
}

/**
 * ArtifactSchema — The schema definition inside an Artifact.
 *
 * A form-first property-based schema that defines the shape of data.
 * Each property uses a User Forms field type (text, textarea, number, select,
 * checkbox, radio, date, time, datetime) with optional constraints
 * (required, options, min, max, pattern, description).
 *
 * This unifies artifact schemas with the User Forms system so the same
 * field definitions can drive both validation and UI rendering.
 */
export interface ArtifactSchema {
  /** Schema name (matches the artifact name) */
  name: string;

  /** Human-readable title */
  title: string;

  /** Top-level type (usually "object") */
  type: string;

  /** Named properties with their types and optional constraints */
  properties: Record<string, ArtifactProperty>;

  /**
   * If true, validation rejects data with properties not listed in `properties`.
   * Default: false (extra properties are allowed).
   */
  strict?: boolean;

  /**
   * If true, the gate carries an array of objects (each matching `properties`)
   * instead of a single object. This is the foundation for Split/Join patterns:
   * a Split node produces an array of artifacts, and a Join node consumes one.
   *
   * When `isArray` is true:
   * - `validateArtifactSchema` expects an array and validates each element
   *   against the object schema defined by `properties`.
   * - `artifactSchemaToZod` returns `z.array(z.object(shape))` instead of
   *   `z.object(shape)`.
   *
   * Default: false (single object — backwards compatible).
   */
  isArray?: boolean;
}

/**
 * FieldType — the set of input control types, shared with User Forms.
 *
 * | Type      | Renders as        | Value type   | Constraints        |
 * |-----------|-------------------|--------------|--------------------|
 * | text      | Single-line input | string       | pattern, min/max*  |
 * | textarea  | Multi-line input  | string       | pattern            |
 * | number    | Number input      | number       | min, max           |
 * | select    | Dropdown          | string       | options (required) |
 * | checkbox  | Checkbox          | boolean      | —                  |
 * | radio     | Radio buttons     | string       | options (required) |
 * | date      | Date picker       | string       | min, max (ISO)     |
 * | time      | Time picker       | string       | —                  |
 * | datetime  | DateTime picker   | string       | min, max (ISO)     |
 *
 * * text min/max are not standard but reserved for future string-length limits.
 */
export type FieldType = 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'radio' | 'date' | 'time' | 'datetime';

/**
 * FieldOption — a single choice for select/radio fields.
 */
export interface FieldOption {
  /** Machine-readable value */
  value: string;
  /** Human-readable label */
  label: string;
}

/**
 * A single property within an ArtifactSchema.
 *
 * Uses the User Forms field type system (FieldType) instead of JSON Schema types.
 * Properties can declare:
 * - `options`: required for select/radio — the available choices
 * - `min`/`max`: bounds (number for 'number', ISO string for 'date'/'datetime')
 * - `pattern`: regex pattern for text/textarea validation
 * - `description`: human-readable description of the property
 *
 * UI metadata (used by the output form to render fields nicely):
 * - `label`: display name (distinct from the key). E.g. "Destinatario" instead of "to"
 * - `placeholder`: helper text inside the input. E.g. "destinatario@email.com"
 * - `defaultValue`: value pre-loaded when the field is empty
 * - `hint`: help text shown below the field. E.g. "Email del destinatario principal"
 */
export interface ArtifactProperty {
  /** Property name */
  name: string;

  /** Field type: text, textarea, number, select, checkbox, radio, date, time, datetime */
  type: FieldType;

  /** Whether this property is required */
  required?: boolean;

  /** Required for select/radio — the available choices */
  options?: FieldOption[];

  /** Lower bound: number for 'number', ISO string for 'date'/'datetime' */
  min?: number | string;

  /** Upper bound: number for 'number', ISO string for 'date'/'datetime' */
  max?: number | string;

  /** Regex pattern for text/textarea validation (e.g. email, url, phone) */
  pattern?: string;

  /** Human-readable description of this property */
  description?: string;

  // ── UI metadata (used by the output form) ──────────────────────────────

  /** Display name for the field (distinct from the property key). E.g. "Destinatario" instead of "to" */
  label?: string;

  /** Placeholder text inside the input. E.g. "destinatario@email.com" */
  placeholder?: string;

  /** Value pre-loaded when the field is empty. Can be a string, number, boolean, or template. */
  defaultValue?: unknown;

  /** Help text shown below the field. E.g. "Email del destinatario principal" */
  hint?: string;
}

// ============================================================================
// GATE — Typed port on a node (input or output), referencing an Artifact
// ============================================================================


/**
 * Gate — A typed port on a node.
 *
 * A gate references an Artifact via `schemaId`. The artifact defines what
 * type of data flows through this gate.
 *
 * If `schemaId` is null, the gate is signal-only (control flow, no data).
 *
 * If the output of a task does not satisfy the output gate's artifact schema
 * → the task is rejected and cannot be marked as Done until it complies.
 */
export interface Gate {
  /** Unique identifier within the node (e.g., "gate_in_1", "gate_out_text") */
  gateId: string;

  /** References an Artifact by artifactId, or null for signal-only (no data) */
  schemaId: string | null;

  /** Human-readable label shown in the editor */
  label?: string;

  /** Whether the node can modify the input object (for input gates) */
  allowModifying?: boolean;
}

// ============================================================================
// NODE — Unit of work within a flow
// ============================================================================

/**
 * Node type — determines how the node is processed during execution.
 *
 * | Type        | What it does                                    | Handler              |
 * |------------|-------------------------------------------------|----------------------|
 * | start       | Entry point, receives trigger data              | StartNodeHandler      |
 * | action      | Creates a task (agent or human)                 | ActionNodeHandler     |
 * | end         | Terminal node                                    | EndNodeHandler        |
 * | function    | Programmatic node, executes code automatically  | FunctionNodeHandler   |
 * | pin         | Proxy/rerouting, passes data through unchanged  | PinNodeHandler        |
 * | integration | Executes an external integration via MCA        | IntegrationNodeHandler|
 * | split       | Fan-out: receives array, creates N parallel branches (one per item) | SplitNodeHandler |
 * | join        | Fan-in: waits for all split branches to arrive, collects outputs into an array | JoinNodeHandler |
 */
export type NodeType = 'start' | 'action' | 'end' | 'function' | 'pin' | 'integration' | 'split' | 'join';

/**
 * Node — A unit of work within a flow.
 *
 * Nodes are embedded inside Flow documents (they are always read together
 * with the flow definition and rarely queried independently).
 *
 * The `role` field maps to either an agentId (for agent-executed tasks) or
 * the literal string 'human' (for human review/approval tasks).
 */
export interface WorkflowNode {
  /** Unique identifier within the flow (e.g., "node_abc123") */
  nodeId: string;

  /** Node type — determines processing behavior */
  type: NodeType;

  /** Human-readable label shown in the editor */
  label: string;

  /** Description of what this node does */
  description: string;

  /**
   * Instructions sent to the agent (or human) when a task is created.
   * Supports Markdown and {{variable}} interpolation from input gate data.
   */
  instructions: string;

  /**
   * Who executes this node:
   * - An agentId (e.g., "agent:alice") → agent task via autoplay/headless
   * - The literal 'human' → human task for review/approval
   *
   * Ignored for node types that don't create tasks (start, end, function, pin, integration).
   */
  role: string;

  /** Color for visual identification in the editor (hex) */
  color: string;

  /** Visual layout direction (for the React Flow editor) */
  direction: string;

  /** Input gates — data the node receives */
  inputs: Gate[];

  /** Output gates — data the node produces */
  outputs: Gate[];

  /** Visual position in the React Flow editor (for persistence) */
  position: { x: number; y: number };

  /** Node-specific configuration (e.g., function code, integration config) */
  data?: Record<string, unknown>;

  /**
   * Project ID override for this node — when set, tasks created by this
   * action node go to this project's board instead of the flow's default
   * projectId. Only meaningful for action nodes.
   */
  projectId?: string;
}

// ============================================================================
// EDGE — Connection between nodes
// ============================================================================

/**
 * Edge — A directed connection from an output gate of one node
 * to an input gate of another node.
 *
 * Uses Flowing's naming convention:
 * - outputNodeId / outputId: the source node and its output gate
 * - inputNodeId / inputId: the target node and its input gate
 *
 * Edges are embedded inside Flow documents alongside nodes.
 */
export interface WorkflowEdge {
  /** Unique identifier within the flow (e.g., "edge_xyz789") */
  edgeId: string;

  /** Flow this edge belongs to (denormalized for querying) */
  flowId: string;

  /** Optional label shown on the edge in the editor */
  label?: string;

  /** Source node ID (references WorkflowNode.nodeId within the same flow) */
  outputNodeId: string;

  /** Source gate ID (references a Gate.gateId in the source node's outputs) */
  outputId: string;

  /** Target node ID (references WorkflowNode.nodeId within the same flow) */
  inputNodeId: string;

  /** Target gate ID (references a Gate.gateId in the target node's inputs) */
  inputId: string;

  /** Edge color for the editor (hex, derived from source gate's artifact color) */
  color?: string;
}

// ============================================================================
// TRIGGER — What starts a flow execution
// ============================================================================

/**
 * Trigger type — how a flow execution is initiated.
 *
 * | Trigger  | How                                                    |
 * |----------|--------------------------------------------------------|
 * | manual   | User clicks "Run" in UI                                 |
 * | schedule | Scheduler recurring task fires                           |
 * | webhook  | Webhook inbound receives payload                         |
 * | event    | System event matches trigger rule                        |
 */
export type TriggerType = 'manual' | 'schedule' | 'webhook' | 'event';

/**
 * Trigger — Configuration for how a flow can be started.
 *
 * Multiple triggers can be defined on a single flow (e.g., manual + schedule).
 */
export interface Trigger {
  /** Unique identifier within the flow */
  triggerId: string;

  /** Trigger type */
  type: TriggerType;

  /**
   * Trigger-specific configuration:
   * - schedule: { cronExpression: string, timezone?: string }
   * - webhook: { webhookId: string, secret?: string }
   * - event: { topic: string, rules?: Record<string, unknown>[] }
   * - manual: {} (no config needed)
   */
  config: Record<string, unknown>;
}

// ============================================================================
// FLOW — Directed graph (MongoDB collection: flows)
// ============================================================================

/**
 * Flow status lifecycle:
 * - draft: Being edited, not yet executable
 * - active: Published, can be executed
 * - archived: Soft-deleted, no new executions
 */
export type FlowStatus = 'draft' | 'active' | 'archived';

/**
 * Flow — A directed graph of nodes connected by edges.
 *
 * Stored in the `flows` MongoDB collection. Nodes and edges are embedded
 * as sub-documents since they are always read together with the flow
 * and are never queried independently.
 *
 * A flow has one or more triggers that can start an execution.
 */
export interface Flow {
  /** Unique identifier (e.g., "flow_abc123def456") */
  flowId: string;

  /** Workspace this flow belongs to */
  workspaceId: string;

  /**
   * Default project ID for this flow — when the flow is executed, tasks are
   * created on this project's board. Can be overridden per action node via
   * WorkflowNode.projectId. If not set, the caller must provide a projectId
   * at execution time.
   */
  projectId?: string;

  /** Human-readable name */
  name: string;

  /** Description of what this flow does */
  description: string;

  /** Nodes in the graph (embedded) */
  nodes: WorkflowNode[];

  /** Edges in the graph (embedded) */
  edges: WorkflowEdge[];

  /** Triggers that can start this flow */
  triggers: Trigger[];

  /** Flow lifecycle status */
  status: FlowStatus;

  /** User who created the flow */
  createdBy: string;

  /** Creation timestamp */
  createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;
}

// ============================================================================
// EXECUTION — Single run of a flow (MongoDB collection: executions)
// ============================================================================

/**
 * Execution status:
 * - running: Execution is in progress
 * - completed: All paths reached end nodes successfully
 * - failed: An error occurred
 * - paused: Waiting for external input (e.g., human task)
 * - cancelled: Manually cancelled by user (stale, buggy, or no longer needed)
 */
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';

/**
 * Execution — A single run of a flow.
 *
 * Stored in the `executions` MongoDB collection.
 * Individual node executions are tracked as ExecutionStep documents
 * in the `execution_steps` collection (separate for queryability).
 *
 * The `currentNodes` field tracks which nodes are currently active
 * (being processed or waiting for task completion).
 */
export interface Execution {
  /** Unique identifier (e.g., "exec_abc123def456") */
  executionId: string;

  /** Reference to the flow (foreign key to flows.flowId) */
  flowId: string;

  /** Workspace this execution belongs to */
  workspaceId: string;

  /** Execution status */
  status: ExecutionStatus;

  /** How this execution was triggered */
  triggeredBy: TriggerType;

  /** Trigger payload data (e.g., webhook body, schedule data, event payload) */
  triggerData?: unknown;

  /**
   * Node IDs currently being processed (running or waiting for task completion).
   * Empty when execution is completed/failed/paused.
   */
  currentNodes: string[];

  /** When the execution started */
  startedAt: Date;

  /** When the execution completed (set on completion or failure) */
  completedAt?: Date;

  /** Error message if status === 'failed' */
  error?: string;

  /**
   * Snapshot of the flow definition at the time the execution was started.
   *
   * This is a full copy of the Flow document (nodes, edges, triggers, etc.)
   * captured at startExecution time. The engine uses this snapshot — not the
   * live flow document — when advancing the execution (advanceExecution).
   *
   * Without this snapshot, updating a flow via upsert (create-flow with an
   * existing flowId) while an execution is running would cause the engine to
   * use the new flow definition, potentially creating duplicate tasks for
   * nodes that already have running steps (the new edges could point to nodes
   * that already have tasks, and cascadeFromNode doesn't check for existing
   * steps).
   */
  flowSnapshot?: Flow;

  /**
   * Active split branches in this execution.
   *
   * When a Split node fires, it creates N branches (one per array item).
   * Each branch gets a unique `branchId` (e.g., "branch_0", "branch_1").
   * Downstream steps carry this `branchId` so the engine can track which
   * branch each step belongs to.
   *
   * A Join node (Phase 3) will consume all branches and merge them back
   * into a single path. Until then, branches run independently to their
   * respective end nodes.
   *
   * Empty array when no splits have occurred (normal linear execution).
   */
  splitBranches: string[];

  /**
   * Maps each branchId to the nodeId of the Split node that created it.
   *
   * Used by Join nodes to determine which split they are collecting from,
   * especially in nested-split scenarios where multiple Split nodes have
   * fired. The Join node looks up its feeder Split by checking which
   * branchIds have splitOrigin pointing to the Split node upstream of it.
   *
   * Empty when no splits have occurred.
   */
  splitOrigins?: Record<string, string>;

  /** Metadata */
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// EXECUTION STEP — Individual node execution (MongoDB collection: execution_steps)
// ============================================================================

/**
 * ExecutionStep status:
 * - pending: Created but not yet started
 * - running: Node is being processed (task is executing)
 * - completed: Node finished successfully, output validated
 * - failed: Node failed (task error or output validation failed)
 * - blocked: Waiting for a dependency or external input
 * - retry: Function node waiting to retry after backoff
 */
export type ExecutionStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'retry';

/**
 * ExecutionStep — A single node's execution within an Execution.
 *
 * Stored in the `execution_steps` MongoDB collection (separate from the
 * Execution document for efficient querying by taskId, nodeId, status, etc.).
 *
 * Each step tracks:
 * - Which node it corresponds to (nodeId)
 * - Which board task was created (taskId, if applicable)
 * - Input data received from upstream gates
 * - Output data produced (validated against the node's output gate artifact)
 * - Schema IDs for input/output (referencing artifacts)
 * - Status and timing
 * - Retry info (for function nodes with backoff)
 */
export interface ExecutionStep {
  /** Unique identifier (e.g., "step_abc123def456") */
  stepId: string;

  /** Reference to the execution (foreign key to executions.executionId) */
  executionId: string;

  /** Reference to the flow (denormalized for querying) */
  flowId: string;

  /** Workspace this step belongs to (denormalized for querying) */
  workspaceId: string;

  /** Reference to the node within the flow (matches WorkflowNode.nodeId) */
  nodeId: string;

  /**
   * Branch identifier — which split branch this step belongs to.
   *
   * - For steps before any Split node: undefined (the "trunk" path)
   * - For steps created by a Split node's fan-out: the branch's ID
   *   (e.g., "branch_0", "branch_1", ...)
   * - For steps downstream of a Split (in a branch): inherited from the
   *   split step that created the branch
   *
   * The engine uses branchId to:
   * 1. Relax the duplicate-node guard — the same node can appear in
   *    multiple branches, each with a different branchId
   * 2. Resolve input data correctly — only pick up upstream data from
   *    the same branch
   */
  branchId?: string;

  /**
   * Reference to the board task created for this step (if applicable).
   * Absent for node types that don't create tasks (start, end, function, pin, integration).
   */
  taskId?: string;

  /** Step status */
  status: ExecutionStepStatus;

  /** Input data received from upstream gates (keyed by gateId) */
  inputData?: Record<string, unknown>;

  /** Output data produced (validated against the node's output gate artifact) */
  outputData?: Record<string, unknown>;

  /** Schema ID (artifactId) for the input gate, if applicable */
  inputSchemaId?: string;

  /** Schema ID (artifactId) for the output gate, if applicable */
  outputSchemaId?: string;

  /** When this step started processing */
  startedAt?: Date;

  /** When this step completed (successfully or with error) */
  completedAt?: Date;

  /** Error message if status === 'failed' */
  error?: string;

  /** Number of retry attempts (for function nodes with backoff) */
  retryAttempts?: number;

  /** When the next retry should occur (for function nodes with backoff) */
  nextRetryAt?: Date;

  // --- Join node tracking (Phase 3) ------------------------------------------

  /**
   * Branch IDs that have arrived at this Join node step.
   *
   * Only set on Join node steps. As each branch completes and cascades
   * to the Join node, its branchId is added to this array. When
   * arrivedBranchIds.length === expectedCount, the Join is complete and
   * the step transitions from blocked → completed.
   *
   * Undefined for non-Join steps.
   */
  arrivedBranchIds?: string[];

  /**
   * Total number of branches expected at this Join node.
   *
   * Determined by counting the branches created by the feeder Split node.
   * Only set on Join node steps. When arrivedBranchIds.length reaches
   * this value, the Join fires.
   *
   * Undefined for non-Join steps.
   */
  expectedCount?: number;

  /** Metadata */
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// TASK EXTENSIONS (for the existing Task model in board-manager)
// ============================================================================
//
// These fields should be added to the existing Task document type to support
// workflow integration. They are defined here as a separate interface so the
// backend can extend its Task type without importing the full workflow package.
//
// See: /opt/teros/packages/backend/src/types/database.ts (Task interface)

/**
 * Workflow-related fields that extend the existing Task model.
 *
 * When a workflow node executes, it creates a Task on the board with these
 * additional fields set. The engine uses them to:
 * - Validate task output against the output gate's artifact schema
 * - Link the task back to its workflow execution and node
 * - Track input/output data for the deliverable
 */
export interface WorkflowTaskExtensions {
  /** Input gate — references an artifact via schemaId */
  inputGate?: Gate;

  /** Output gate — references an artifact via schemaId */
  outputGate?: Gate;

  /** Input artifact ({ schemaId, schema?, data }) — owned by the task; the engine fills it from the upstream gates */
  input?: { schemaId: string | null; schema?: ArtifactSchema; data?: unknown };

  /** Output artifact ({ schemaId, schema?, data? }) — the deliverable; data is set on completion */
  output?: { schemaId: string | null; schema?: ArtifactSchema; data?: unknown };

  /** Reference to the workflow execution that created this task */
  workflowExecutionId?: string;

  /** Reference to the workflow node that created this task */
  workflowNodeId?: string;
}
