/**
 * Database Types
 *
 * Schema definitions for MongoDB collections:
 * - models: Available LLM models catalog
 * - agent_cores: Base personality engines
 * - agents: User-facing agent instances
 * - mca_catalog: Available MCPs to install
 * - apps: User-installed MCP instances with configuration
 * - agent_app_access: Agent permissions to use apps
 */

// ============================================================================
// MODELS COLLECTION
// ============================================================================

/**
 * LLM Model - Available model in the catalog
 *
 * Defines a model's capabilities, pricing tier, and default configuration.
 * Agent cores reference models by modelId.
 */
export interface Model {
  /** Unique identifier (e.g., 'claude-sonnet-4', 'gpt-4o') */
  modelId: string;

  /**
   * LLM Provider
   * - 'anthropic': Uses API key authentication
   * - 'anthropic-oauth': Uses OAuth (Claude Max subscription)
   * - 'openai': OpenAI API
   * - 'openrouter': OpenRouter unified API (400+ models)
   * - 'google': Google AI (Gemini models)
   * - 'groq': Groq API (fast inference)
   * - 'zhipu': Z.ai / ZhipuAI API (GLM models)
   * - 'zhipu-coding': Z.ai coding API endpoint (GLM models optimized for coding)
   * - 'ollama': Local Ollama models
   * - 'openai-codex-oauth': Uses OAuth (ChatGPT Pro/Plus subscription via Codex)
   */
  provider:
    | 'anthropic'
    | 'anthropic-oauth'
    | 'openai'
    | 'openai-codex-oauth'
    | 'openrouter'
    | 'google'
    | 'groq'
    | 'zhipu'
    | 'zhipu-coding'
    | 'ollama';

  /** Human-readable name */
  name: string;

  /** Full description */
  description?: string;

  /** Actual model string sent to API (e.g., 'claude-sonnet-4-20250514') */
  modelString: string;

  /** Model capabilities */
  capabilities: {
    streaming: boolean;
    tools: boolean;
    vision: boolean;
    thinking?: boolean; // Extended thinking (Claude)
  };

  /** Context window configuration */
  context: {
    /** Maximum context window (total tokens) */
    maxTokens: number;
    /** Maximum output tokens */
    maxOutputTokens: number;
  };

  /**
   * Billing type determines how usage is tracked
   * - 'usage': Pay per token (API key models) - track cost
   * - 'subscription': Token quota (OAuth/Claude Max) - track against limit
   *
   * Optional for backward compatibility. If not set, inferred from provider:
   * - 'anthropic-oauth' → 'subscription'
   * - All others → 'usage'
   */
  billingType?: 'usage' | 'subscription';

  /**
   * Pricing per million tokens (USD)
   * Used for billingType: 'usage' models
   * Optional - if not provided, cost tracking will be disabled for this model
   */
  cost?: {
    /** Cost per million input tokens */
    input: number;
    /** Cost per million output tokens */
    output: number;
    /** Cost per million cached input tokens read (optional) */
    cacheRead?: number;
    /** Cost per million cached input tokens written (optional) */
    cacheWrite?: number;
  };

  /**
   * Quota configuration for subscription models
   * Used for billingType: 'subscription' models (e.g., Claude Max)
   *
   * Known limits (Jan 2026 research):
   * - Pro: ~44,000 tokens per 5h window
   * - Max5: ~88,000 tokens per 5h window
   * - Max20: ~220,000 tokens per 5h window
   */
  quota?: {
    /** Rolling window duration in hours (default: 5 for Claude Max) */
    windowHours: number;
    /** Token limit per window */
    tokensPerWindow: number;
    /** Weekly token limit (optional, null if unknown) */
    weeklyTokens?: number;
    /** Alert threshold as percentage, e.g., 0.8 = alert at 80% (optional) */
    alertAt?: number;
  };

  /** Default generation parameters */
  defaults: {
    temperature: number;
    maxTokens: number; // Default output tokens to request
  };

  /** Token reservations for budgeting */
  reservations: {
    /** Tokens reserved for system prompt */
    systemPrompt: number;
    /** Tokens reserved for memory context */
    memory: number;
    /** Tokens reserved for output */
    output: number;
  };

  /** Auto-compaction settings */
  compaction: {
    /** Trigger compaction at this token count */
    triggerAt: number;
    /** Target size after compaction */
    targetSize: number;
    /** Protect recent tokens from compaction */
    protectRecent: number;
  };

  /** Model status */
  status: 'active' | 'deprecated' | 'disabled';

  /**
   * Provider-specific configuration
   * Allows each provider to have custom settings without polluting the base Model type.
   *
   * Examples:
   * - OpenRouter: { routingStrategy: 'cheapest' | 'fastest' | 'best' }
   * - Future providers can add their own configs here
   */
  providerConfig?: Record<string, any>;

  /** Metadata */
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// AGENT CORES COLLECTION
// ============================================================================

/**
 * Agent Core - Base personality/engine
 *
 * Defines the core identity, system prompt, and LLM configuration.
 * Can override model defaults with core-specific settings.
 */
export interface AgentCore {
  /** Unique identifier (e.g., 'alice', 'iria') */
  coreId: string;

  /** Human-readable name */
  name: string;

  /** Full name */
  fullName: string;

  /** Version */
  version: string;

  /** Base system prompt */
  systemPrompt: string;

  /** Personality traits */
  personality: string[];

  /** Core capabilities */
  capabilities: string[];

  /** Default avatar URL */
  avatarUrl: string;

  // === LLM Configuration ===

  /** Reference to model (foreign key to models.modelId) */
  modelId: string;

  /**
   * Override model defaults (optional)
   * If not specified, uses model's defaults
   */
  modelOverrides?: {
    temperature?: number;
    maxTokens?: number;
  };

  /** Core status */
  status: 'active' | 'inactive';

  /** Metadata */
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// AGENT INSTANCES COLLECTION
// ============================================================================

/**
 * Agent Instance - User-facing agent using a core
 *
 * Represents a specific agent that users interact with.
 * Uses a core for its base personality and can add customizations.
 */
export interface AgentInstance {
  /** Unique identifier (e.g., 'agent:alice') */
  agentId: string;

  /** Reference to core (foreign key to agent_cores.coreId) */
  coreId: string;

  /** Human-readable name */
  name: string;

  /** Full name */
  fullName: string;

  /** Role description */
  role: string;

  /** User-facing introduction */
  intro: string;

  /** Optional avatar (falls back to core's avatar) */
  avatarUrl?: string;

  /** Instance status */
  status: 'active' | 'inactive';

  /** Optional owner (for personal agent instances) */
  ownerId?: string;

  /**
   * Optional workspace ID (for workspace-scoped agents)
   * - If null/undefined: Global agent, can access user's global apps
   * - If set: Workspace agent, can only access apps from that workspace
   */
  workspaceId?: string;

  /** Agent-specific context (injected after identity in system prompt) */
  context?: string;

  /** Maximum conversation steps (0 = unlimited, undefined = use default) */
  maxSteps?: number;

  /** Metadata */
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// RESOLVED TYPES (with joined data)
// ============================================================================

/**
 * Resolved Agent Core - Core with its model data joined
 */
export interface ResolvedAgentCore extends Omit<AgentCore, 'modelId'> {
  model: Model;
  /** Effective config (model defaults + core overrides) */
  effectiveConfig: {
    temperature: number;
    maxTokens: number;
  };
}

/**
 * Resolved Agent - Instance with its core and model data joined
 */
export interface ResolvedAgent extends Omit<AgentInstance, 'coreId'> {
  core: ResolvedAgentCore;
}

// ============================================================================
// MCP CATALOG COLLECTION
// ============================================================================

/**
 * JSON Schema definition for MCA configuration
 */
export interface McaConfigSchema {
  type: 'object';
  properties: Record<
    string,
    {
      type: string;
      description?: string;
      default?: any;
      format?: string; // e.g., 'password', 'uri', 'email'
    }
  >;
  required?: string[];
}

/**
 * MCP Catalog Entry - Available MCP that can be installed
 *
 * Defines an MCP's metadata, how to run it, and what configuration it needs.
 *
 * Configuration is split into two types:
 * - secrets: Application-level credentials (API keys, OAuth client_id/secret)
 *            Configured by admin, shared across users
 * - auth: User-level credentials (OAuth tokens, refresh tokens)
 *         Unique per user, stored in the App instance
 */
export interface McpCatalogEntry {
  /** Unique identifier (e.g., 'mca.teros.bash', 'mca.github') */
  mcaId: string;

  /** Human-readable name */
  name: string;

  /** Description of what this MCP does */
  description: string;

  /** MCP execution configuration */
  execution: {
    /** Command to run (e.g., 'node', 'npx', 'bun') */
    command: string;
    /** Arguments to pass (e.g., ['dist/index.js'] or ['-y', '@anthropic/mcp-filesystem']) */
    args: string[];
    /** Working directory (optional, relative to mcas folder) */
    cwd?: string;
  };

  /**
   * Availability configuration
   * Controls who can access this MCA and how
   */
  availability: {
    /**
     * Master switch - if false, MCA is completely unavailable
     * Takes precedence over all other settings
     */
    enabled: boolean;
    /**
     * If true, users can install multiple instances (e.g., multiple Gmail accounts)
     */
    multi: boolean;
    /**
     * If true, automatically available to all agents without explicit app/access setup
     * Examples: memory, scheduler, conversation search
     */
    system: boolean;
    /**
     * If true, hidden from App Store catalog (but still usable if installed)
     */
    hidden: boolean;
    /**
     * Minimum role required to use this MCA
     * - 'user': Available to all users
     * - 'admin': Only admins can use
     * - 'super': Only super admins can use
     */
    role: 'user' | 'admin' | 'super';
  };

  /**
   * System-level secrets required (e.g., ['CLIENT_ID', 'CLIENT_SECRET'])
   * These are configured by admin, stored in .secrets/mcas/<mcaId>/credentials.json
   */
  systemSecrets?: string[];

  /**
   * User-level secrets required (e.g., ['ACCESS_TOKEN', 'REFRESH_TOKEN', 'EMAIL'])
   * These are unique per user, stored encrypted in user_credentials collection
   */
  userSecrets?: string[];

  /**
   * OAuth/Auth configuration from manifest
   */
  auth?: {
    type: 'oauth2' | 'apikey' | 'none';
    provider?: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    scopes?: string[];
    pkce?: boolean;
  };

  /**
   * @deprecated Use systemSecrets instead
   * Schema for application-level secrets (API keys, OAuth app credentials)
   */
  secretsSchema?: McaConfigSchema;

  /**
   * @deprecated Use userSecrets and auth instead
   * Schema for user-level authentication (OAuth tokens, user credentials)
   */
  authSchema?: McaConfigSchema;

  /** Tools this MCP provides */
  tools: string[];

  /** Category for organization */
  category:
    | 'productivity'
    | 'communication'
    | 'development'
    | 'system'
    | 'ai'
    | 'data'
    | 'media'
    | 'design'
    | 'storage'
    | 'utility'
    | 'other';

  /** Icon identifier (lucide icon name) or URL */
  icon?: string;

  /** Brand color for icon background */
  color?: string;

  /**
   * Runtime configuration for containerized MCAs
   * If not present, MCA runs as stdio process (legacy mode)
   */
  runtime?: {
    /** Transport type: 'http' for containers, 'stdio' for local processes */
    transport: 'http' | 'stdio';
    /** Container port (default: 3000) */
    port?: number;
    /** Health check endpoint (default: '/health') */
    healthCheck?: string;
    /**
     * Container mode for HTTP transport:
     * - 'shared': One container per MCA, shared across all users (default)
     * - 'per-app': One container per installed app instance
     */
    containerMode?: 'shared' | 'per-app';
    /**
     * Custom Docker image for this MCA.
     * If not specified, uses the default 'teros/mca-runtime' image.
     */
    dockerImage?: string;
    /**
     * System-level volume mounts added to the container at launch.
     * Use sparingly — only for trusted MCAs that need host access (e.g., Docker socket).
     */
    systemVolumes?: Array<{
      hostPath: string;
      containerPath: string;
      readOnly?: boolean;
    }>;
    /**
     * Additional environment variables injected at container launch time.
     * Merged with the standard MCA environment variables.
     * Values support $VAR or ${VAR} interpolation against the backend process environment.
     * Example: "DOCKER_ENV_DOMAIN": "${DOCKER_ENV_DOMAIN}"
     */
    systemEnvironment?: Record<string, string>;
  };

  /** MCP status - deprecated, use availability.enabled instead */
  status: 'active' | 'deprecated' | 'disabled';

  /** Metadata */
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// WORKSPACES COLLECTION
// ============================================================================

/**
 * Workspace - A collaborative context with its own volume and apps
 *
 * Workspaces provide isolated environments for projects. Each workspace has:
 * - Its own volume (1:1 relationship)
 * - Apps installed specifically for that workspace
 * - Members with different access levels
 *
 * Users can have multiple workspaces and share them with others.
 */
export interface Workspace {
  /** Unique identifier (e.g., "work_my-project", "work_dev-team") */
  workspaceId: string;

  /** Human-readable name */
  name: string;

  /** Optional description */
  description?: string;

  /**
   * Context text that gets injected into agent system prompts.
   * Use this to provide project-specific information, guidelines,
   * coding standards, or any other context that agents should know.
   * Can be long (multiple paragraphs, markdown supported).
   */
  context?: string;

  /** User who created the workspace */
  ownerId: string;

  /** Associated volume (1:1 relationship) */
  volumeId: string;

  /**
   * Members with access (owner has implicit 'owner' role, not listed here)
   * For future collaboration feature
   */
  members: Array<{
    userId: string;
    role: 'admin' | 'write' | 'read';
    addedAt: string;
    addedBy: string;
  }>;

  /** Workspace settings */
  settings: {
    /** Default git branch for dev workspaces */
    defaultBranch?: string;
  };

  /**
   * Visual appearance customization
   */
  appearance?: {
    /** Color name from design system (e.g., 'blue', 'purple') */
    color?: string;
    /** Lucide icon name in kebab-case (e.g., 'git-branch', 'rocket') */
    icon?: string;
  };

  /** Status */
  status: 'active' | 'archived';

  /** Metadata */
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// APPS COLLECTION
// ============================================================================

/**
 * App - User or Workspace-installed MCP instance with configuration
 *
 * When a user "installs" an MCP, they create an App with their specific config.
 * Apps can belong to a user (personal) or a workspace (shared).
 *
 * Configuration is split into:
 * - secrets: Application-level credentials (from McpCatalogEntry.secretsSchema)
 * - auth: User-level credentials (from McpCatalogEntry.authSchema)
 * - permissions: Tool-level permissions (allow/ask/forbid per tool)
 */
export interface App {
  /** Unique identifier (e.g., 'app_abc123') */
  appId: string;

  /** Reference to MCA catalog (foreign key to mca_catalog.mcaId) */
  mcaId: string;

  /**
   * Owner of this app instance
   * - If ownerType='user': this is a userId
   * - If ownerType='workspace': this is a workspaceId
   */
  ownerId: string;

  /**
   * Type of owner - determines access resolution
   * - 'user': Personal app, only accessible by the user's agents
   * - 'workspace': Workspace app, accessible by all workspace members
   * @default 'user' for backwards compatibility
   */
  ownerType?: 'user' | 'workspace';

  /** Human-readable name for this instance */
  name: string;

  /**
   * User-level authentication data (OAuth tokens, refresh tokens)
   * Validated against MCP's authSchema
   * This is unique per user and may include:
   * - access_token, refresh_token for OAuth
   * - api_key for user-specific keys
   * - etc.
   *
   * NOTE: System-level secrets (API keys) are NOT stored here.
   * They are loaded from filesystem (.secrets/mcas/<mcaId>/credentials.json)
   * at runtime via SecretsManager. See mca-service.ts for details.
   */
  auth?: Record<string, any>;

  /**
   * Tool-level permissions (allow/ask/forbid per tool)
   * Controls what the agent can do with each tool.
   * If not set, all tools default to 'ask'.
   */
  permissions?: AppToolPermissions;

  /**
   * Volume mounts for this app
   * Each mount binds a volume to a path inside the container
   */
  volumes?: Array<{
    /** Volume ID to mount (e.g., "vol_user_pablo", "vol_work_alpha") */
    volumeId: string;
    /** Path inside container (e.g., "/workspace") */
    mountPath: string;
    /** Mount as read-only (default: false) */
    readOnly?: boolean;
  }>;

  /** App-specific context
   * Can be used to provide configuration or additional info for app
   */
  context?: string;

  /** App status */
  status?: 'active' | 'disabled';

  /** Metadata */
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// AGENT APP ACCESS COLLECTION
// ============================================================================

/**
 * Permission level for a tool
 * - 'allow': Agent can use the tool without user intervention
 * - 'ask': Agent must request user confirmation before using the tool
 * - 'forbid': Agent cannot use the tool at all
 */
export type ToolPermission = 'allow' | 'ask' | 'forbid';

/**
 * Tool-level permissions for an app
 */
export interface AppToolPermissions {
  /**
   * Permissions per tool (toolName -> permission)
   * Tools not listed here use defaultPermission
   */
  tools: Record<string, ToolPermission>;

  /**
   * Default permission for tools not explicitly listed
   * @default 'ask'
   */
  defaultPermission: ToolPermission;
}

/**
 * Agent App Access - Permission for an agent to use an app
 *
 * Links agents to apps they're allowed to use.
 * Supports granular tool-level permissions (allow/ask/forbid).
 */
export interface AgentAppAccess {
  /** Agent that has access (foreign key to agents.agentId) */
  agentId: string;

  /** App they can access (foreign key to apps.appId) */
  appId: string;

  /** Who granted this access */
  grantedBy: string;

  /** When access was granted */
  grantedAt: string;

  /**
   * @deprecated Use permissions.tools instead
   * Optional: restrict to specific tools (if empty, all tools allowed)
   */
  allowedTools?: string[];

  /**
   * Tool-level permissions (allow/ask/forbid per tool)
   * If null/undefined, all tools default to 'ask'
   */
  permissions?: AppToolPermissions;
}

// ============================================================================
// PROJECTS COLLECTION
// ============================================================================

/**
 * Project - A scoped unit of work within a workspace
 *
 * Each project has exactly one board (1:1 relationship).
 * Projects live inside workspaces and provide context for task organization.
 */
export interface Project {
  /** Unique identifier (e.g., "proj_abc123") */
  projectId: string;

  /** Workspace this project belongs to */
  workspaceId: string;

  /** Human-readable name */
  name: string;

  /** Optional description */
  description?: string;

  /** Project-specific context that gets injected into agent system prompts when working on this project */
  context?: string;

  /** User or agent who created this project */
  createdBy: string;

  /** Associated board ID (1:1, auto-created with project) */
  boardId: string;

  /** Status */
  status: 'active' | 'archived';

  /** Metadata */
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// BOARDS COLLECTION
// ============================================================================

/**
 * Board Column definition
 */
export interface BoardColumn {
  /** Unique identifier (e.g., "col_abc123") */
  columnId: string;

  /** Display name (e.g., "In Progress") */
  name: string;

  /** Slug identifier (e.g., "in_progress") */
  slug: string;

  /** Order position (0-based) */
  position: number;
}

/**
 * Board execution config (auto-dispatcher settings)
 */
export interface BoardConfig {
  /** Worker slots per agent (agentId → max concurrent tasks) */
  workerSlots?: Record<string, number>;

  /** Auto-dispatch running state */
  autoDispatchRunning?: boolean;

  /** Selected supervisor agent ID */
  selectedSupervisorId?: string | null;

  /** Active supervisor conversation channel ID */
  activeSupervisorChannelId?: string | null;
}

/**
 * Board - Kanban board associated with a project (1:1)
 *
 * Columns are embedded directly in the board document
 * since a board typically has 3-8 columns.
 */
export interface Board {
  /** Unique identifier (e.g., "board_abc123") */
  boardId: string;

  /** Project this board belongs to (1:1) */
  projectId: string;

  /** Ordered list of columns */
  columns: BoardColumn[];

  /** Auto-dispatcher execution configuration */
  config?: BoardConfig;

  /** Metadata */
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// TASKS COLLECTION
// ============================================================================

/** Task priority levels */
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

/** Task semantic status (decoupled from column position) */
export type TaskStatus = 'idle' | 'assigned' | 'working' | 'blocked' | 'review' | 'done' | 'circular_dependency';

/** Task activity event types */
export type TaskActivityEventType =
  | 'created'
  | 'moved'
  | 'assigned'
  | 'unassigned'
  | 'started'
  | 'linked'
  | 'priority_changed'
  | 'updated'
  | 'deleted'
  | 'status_changed'
  | 'progress_note'
  | 'running_changed'
  | 'dependency_added'
  | 'dependency_removed'
  | 'circular_dependency_detected';

/**
 * Task Activity Log Entry
 *
 * Records significant changes to a task for audit/history.
 */
export interface TaskActivityEntry {
  /** Type of event */
  eventType: TaskActivityEventType;

  /** Who performed the action (userId or agentId) */
  actor: string;

  /** When the event occurred */
  timestamp: string;

  /** Event-specific details */
  details?: {
    fromColumn?: string;
    toColumn?: string;
    agentId?: string;
    channelId?: string;
    oldPriority?: string;
    newPriority?: string;
    field?: string;
    fromStatus?: string;
    toStatus?: string;
    note?: string;
    running?: boolean;
  };
}

/**
 * Progress Note - Agent posts updates about what it's doing
 */
export interface ProgressNote {
  /** Note text */
  text: string;

  /** Who posted the note (agentId or userId) */
  actor: string;

  /** When the note was posted */
  timestamp: string;
}

/**
 * Task - Atomic unit of work on a board
 *
 * Tasks live in columns on a board and can be assigned to agents.
 * When started, a conversation (channel) is created and linked.
 */
export interface Task {
  /** Unique identifier (e.g., "task_abc123") */
  taskId: string;

  /** Board this task belongs to */
  boardId: string;

  /** Current column ID */
  columnId: string;

  /** Position within column (for ordering) */
  position: number;

  /** Task title */
  title: string;

  /** Task description (supports markdown) */
  description?: string;

  /** Priority level */
  priority: TaskPriority;

  /** Semantic status (decoupled from column) */
  taskStatus: TaskStatus;

  /** Free-form tags for categorization and agent matching */
  tags: string[];

  /** Assigned agent ID (nullable) */
  assignedAgentId?: string;

  /** Linked conversation channel ID (nullable) */
  channelId?: string;

  /** Channel from which start_task was called (for event notifications) */
  originChannelId?: string;

  /** Whether the agent is actively processing (system-controlled, not manual) */
  running: boolean;

  /** Parent task ID for sub-tasks (nullable) */
  parentTaskId?: string;

  /**
   * Task dependency IDs — tasks that must be completed before this task can start.
   * Stored as an array of taskIds within the same board.
   * Cycles are forbidden and detected via DFS on every add/update.
   */
  dependencies: string[];

  /** Progress notes from agents/users */
  progressNotes: ProgressNote[];

  /** Activity log */
  activity: TaskActivityEntry[];

  /** User or agent who created this task */
  createdBy: string;

  /** Metadata */
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// RESOLVED MCP TYPES
// ============================================================================

/**
 * Resolved App - App with its MCP catalog data joined
 */
export interface ResolvedApp extends Omit<App, 'mcaId'> {
  mca: McpCatalogEntry;
}

/**
 * Agent's resolved apps - All apps an agent has access to
 */
export interface AgentApps {
  agentId: string;
  apps: Array<{
    app: ResolvedApp;
    access: AgentAppAccess;
  }>;
}

// ============================================================================
// CONVERSATION USAGE COLLECTION
// ============================================================================

/**
 * Token usage breakdown by category
 * Used to visualize how the context window is being used
 */
export interface TokenBreakdown {
  /** Tokens used by system prompt (core + personality + capabilities) */
  system: number;
  /** Tokens used by MCP tool descriptions */
  tools: number;
  /** Tokens used by few-shot examples */
  examples: number;
  /** Tokens used by memory context (retrieved knowledge) */
  memory: number;
  /** Tokens used by compacted conversation summary */
  summary: number;
  /** Tokens used by user messages in conversation history */
  conversation: number;
  /** Tokens used by tool call inputs (JSON arguments) */
  toolCalls?: number;
  /** Tokens used by tool results/outputs */
  toolResults?: number;
  /** Tokens used by assistant responses (output tokens that become input in next turn) */
  output?: number;
}

/**
 * Conversation Usage - Tracks token usage and costs per conversation
 *
 * Updated after each LLM call to provide real-time budget visualization.
 * Stored per channel (conversation) for historical tracking.
 */
export interface ConversationUsage {
  /** Channel/conversation ID (primary key) */
  channelId: string;

  /** Model used for this conversation */
  modelId: string;

  /**
   * Denormalized fields for fast aggregation queries
   * Populated from channel data on first usage update
   */
  userId?: string;
  agentId?: string;
  workspaceId?: string;

  /** Provider for grouping (e.g., 'anthropic', 'anthropic-oauth') */
  provider?: string;

  /** Model's context limit (cached for quick access) */
  contextLimit: number;

  /**
   * Accumulated token counts from all LLM calls
   * Updated after each response
   */
  tokens: {
    /** Total input tokens sent to LLM */
    input: number;
    /** Total output tokens received from LLM */
    output: number;
    /** Cached input tokens read (prompt caching) */
    cacheRead: number;
    /** Cached input tokens written (prompt caching) */
    cacheWrite: number;
  };

  /**
   * Current token breakdown by category
   * Represents the current state of the context window
   */
  breakdown: TokenBreakdown;

  /**
   * Accumulated cost in USD
   * Calculated from tokens * model pricing
   */
  cost: number;

  /** Number of LLM calls in this conversation */
  callCount: number;

  /** Last update timestamp */
  lastUpdated: string;

  /** Creation timestamp */
  createdAt: string;
}

/**
 * Usage Window - Tracks token consumption within a rolling window
 *
 * Used for subscription models (e.g., Claude Max) to track usage
 * against quota limits. Windows are rolling (e.g., 5 hours for Claude Max).
 */
export interface UsageWindow {
  /** Provider account identifier (e.g., 'anthropic-oauth-default') */
  accountId: string;

  /** Window identifier (accountId + windowStart) */
  windowId: string;

  /** Window start time */
  windowStart: string;

  /** Window end time (windowStart + windowHours) */
  windowEnd: string;

  /** Window duration in hours */
  windowHours: number;

  /** Total tokens consumed in this window */
  tokensUsed: number;

  /** Token limit for this window (from model.quota.tokensPerWindow) */
  tokenLimit: number;

  /** Percentage used (0-100) */
  percentUsed: number;

  /** Breakdown by user */
  byUser: Record<string, number>;

  /** Breakdown by agent */
  byAgent: Record<string, number>;

  /** Breakdown by channel */
  byChannel: Record<string, number>;

  /** Last update timestamp */
  lastUpdated: string;
}

/**
 * Token Budget - Real-time view of context window usage
 *
 * This is what gets sent to the frontend for visualization.
 * Calculated from ConversationUsage + current model limits.
 */
export interface TokenBudget {
  /** Model's maximum context window */
  modelLimit: number;

  /** Current total tokens used (sum of breakdown) */
  totalUsed: number;

  /** Percentage of context window used (0-100) */
  percentUsed: number;

  /** Breakdown by category */
  breakdown: TokenBreakdown;

  /** Cost information */
  cost: {
    /** Total cost for this session in USD */
    session: number;
    /** Breakdown by token type */
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    /** Number of LLM API calls in this session */
    callCount: number;
  };

  /** Available tokens remaining */
  available: number;
}

// ============================================================================
// MESSAGES COLLECTION
// ============================================================================

import type { Message as CoreMessage, Part } from '@teros/core';
import type { ObjectId } from 'mongodb';

/**
 * Stored Message - A message in the messages collection
 *
 * Messages are stored separately from sessions for efficient querying,
 * especially when filtering by compaction boundaries.
 */
export interface StoredMessage {
  /** MongoDB ObjectId - used for ordering and compaction boundaries */
  _id?: ObjectId;

  /** Reference to session (foreign key to sessions.id) */
  sessionId: string;

  /** Message info (role, timestamps, etc.) */
  info: CoreMessage;

  /** Message parts (text, tool calls, files, etc.) */
  parts: Part[];
}

// ============================================================================
// COMPACTIONS COLLECTION
// ============================================================================

/**
 * Compaction - A snapshot of compacted conversation history
 *
 * When conversation exceeds token limits, older messages are summarized
 * and stored here. Multiple compactions can exist per session (append-only).
 *
 * To reconstruct conversation for LLM:
 * 1. Get latest compaction for session
 * 2. Use compaction.summary as context
 * 3. Query messages where _id > compaction.lastMessageId
 */
export interface Compaction {
  /** MongoDB ObjectId */
  _id?: ObjectId;

  /** Reference to session (foreign key to sessions.id) */
  sessionId: string;

  /** LLM-generated summary of compacted messages */
  summary: string;

  /**
   * MongoDB ObjectId of the last message included in this compaction
   * Messages with _id > lastMessageId are NOT compacted
   */
  lastMessageId: ObjectId;

  /** Statistics about the compaction */
  stats: {
    /** Number of messages that were compacted */
    messagesCompacted: number;
    /** Token count before compaction */
    tokensBefore: number;
    /** Token count after compaction (summary size) */
    tokensAfter: number;
  };

  /** When this compaction was created */
  createdAt: Date;
}

// ============================================================================
// LLM USAGE TRACKING COLLECTION
// ============================================================================

/**
 * LLM Usage - Tracks every LLM generation for billing and analytics
 *
 * This collection stores detailed usage information for every LLM API call,
 * enabling cost tracking, billing, analytics, and accountability.
 *
 * Use cases:
 * - Generate invoices by user/workspace/organization
 * - Track costs per agent, model, or conversation
 * - Identify expensive conversations or users
 * - Optimize model selection based on actual costs
 * - Reconcile with provider bills (OpenRouter, Anthropic, etc.)
 */
export interface LLMUsage {
  /** Unique identifier */
  usageId: string;

  /** Provider-specific generation ID (e.g., OpenRouter gen-xxx, Anthropic msg_xxx) */
  generationId?: string;

  /** Timestamp of this generation */
  timestamp: Date;

  // ============================================================================
  // CONTEXT - Who/what triggered this generation
  // ============================================================================

  /** User who triggered this generation */
  userId: string;

  /** Workspace context (if applicable) */
  workspaceId?: string;

  /** Organization context (future) */
  organizationId?: string;

  /** Agent that made this generation */
  agentId: string;

  /** Agent core used */
  coreId: string;

  /** Conversation/channel where this happened */
  channelId: string;

  /** Message that triggered this generation */
  messageId: string;

  /** Step number in the conversation (for multi-step agentic flows) */
  step?: number;

  // ============================================================================
  // MODEL INFORMATION
  // ============================================================================

  /** LLM Provider (anthropic, openrouter, openai, ollama, etc.) */
  provider:
    | 'anthropic'
    | 'anthropic-oauth'
    | 'openai'
    | 'openrouter'
    | 'google'
    | 'groq'
    | 'zhipu'
    | 'zhipu-coding'
    | 'ollama';

  /** Model ID in our system (e.g., 'deepseek-v3', 'claude-sonnet-4-5') */
  modelId: string;

  /** Model string sent to API (e.g., 'deepseek/deepseek-chat', 'claude-sonnet-4-5-20250929') */
  modelString: string;

  /**
   * Actual model used by the provider
   * Important for auto-routing scenarios where requested model differs from actual
   * Example: requested 'openrouter/auto' but actually used 'anthropic/claude-sonnet-4.5'
   */
  actualModel?: string;

  /** Provider-specific metadata (e.g., OpenRouter routing info) */
  providerMetadata?: Record<string, any>;

  // ============================================================================
  // TOKEN USAGE
  // ============================================================================

  /** Input/prompt tokens */
  promptTokens: number;

  /** Output/completion tokens */
  completionTokens: number;

  /** Total tokens (prompt + completion) */
  totalTokens: number;

  /** Tokens read from cache (if supported by provider) */
  cacheReadTokens?: number;

  /** Tokens written to cache (if supported by provider) */
  cacheWriteTokens?: number;

  /** Reasoning/thinking tokens (for models like Claude with extended thinking) */
  reasoningTokens?: number;

  // ============================================================================
  // COST TRACKING
  // ============================================================================

  /** Cost for input tokens (USD) */
  costInput: number;

  /** Cost for output tokens (USD) */
  costOutput: number;

  /** Cost for cache reads (USD) */
  costCacheRead?: number;

  /** Cost for cache writes (USD) */
  costCacheWrite?: number;

  /** Cost for reasoning tokens (USD) */
  costReasoning?: number;

  /** Fixed cost per request (USD, if applicable) */
  costRequest?: number;

  /** Total cost for this generation (USD) */
  costTotal: number;

  /** Currency (always USD for now) */
  currency: 'USD';

  // ============================================================================
  // GENERATION DETAILS
  // ============================================================================

  /** Generation parameters used */
  parameters?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    [key: string]: any;
  };

  /** Stop reason (end_turn, tool_calls, max_tokens, error) */
  stopReason?: 'end_turn' | 'tool_calls' | 'max_tokens' | 'error';

  /** Number of tool calls made in this generation */
  toolCallsCount?: number;

  /** Latency in milliseconds (time from request to completion) */
  latencyMs?: number;

  // ============================================================================
  // METADATA
  // ============================================================================

  /** Billing type of the model used */
  billingType?: 'usage' | 'subscription';

  /** Tags for custom categorization */
  tags?: string[];

  /** Additional notes or context */
  notes?: string;

  /** Created timestamp */
  createdAt: Date;
}
