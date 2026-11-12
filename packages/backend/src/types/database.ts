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
   * - 'ollama-cloud': Ollama Cloud hosted models (https://ollama.com/v1, requires API key)
   * - 'openai-codex-oauth': Uses OAuth (ChatGPT Pro/Plus subscription via Codex)
   * - 'openai-compatible': Generic OpenAI-compatible endpoint (Tower, LM Studio, vLLM, etc.)
   * - 'minimax': MiniMax Token Plan (Anthropic-compatible API)
   * - 'teros': Teros official provider via Fireworks AI (Zero Data Retention, OpenAI-compatible API, system secret)
   * - 'cloudflare': User-owned Cloudflare Workers AI (OpenAI-compatible API, user secret)
   * - 'helmcode': Helmcode (EU private inference, open-weight, flat-rate, BYOK, OpenAI-compatible)

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
    | 'ollama'
    | 'ollama-cloud'
    | 'openai-compatible'
    | 'minimax'
    | 'teros'
    | 'cloudflare'
    | 'fireworks'
    | 'together'
    | 'helmcode'


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
  /** Unique identifier (e.g., 'agent', 'super-agent') */
  coreId: string;

  /**
   * Internal core kind. Assigned by the server from the agent's scope
   * (global/personal → 'super-agent'; workspace-scoped → 'agent').
   * Never chosen by the user.
   */
  coreType: 'agent' | 'super-agent';

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

  /**
   * MCA ids preinstalled and granted to every agent of this core on creation
   * (and ensured idempotently afterwards). Only non-system MCAs belong here —
   * system MCAs (e.g. mca.teros.memory) are auto-provisioned separately.
   */
  defaultApps: string[];

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

  /**
   * Optional email address for the agent.
   * Used for skill variable interpolation: {{agent.email}}
   */
  email?: string;

  /** Maximum conversation steps (0 = unlimited, undefined = use default) */
  maxSteps?: number;

  /**
   * Cache block size for the mod-N breakpoint strategy (A/B testing feature flag).
   * undefined = use platform default (20)
   * 0 = disable mod-N, use legacy moving breakpoint
   * N > 0 = snap cache breakpoint to multiples of N
   */
  cacheBlockSize?: number;

  /**
   * @deprecated DEAD FIELD (2026-10-21): the per-agent provider list no longer
   * exists as a concept. Kept in the type only so legacy documents that still
   * carry it typecheck — the runtime never reads or writes it, and the
   * migration 20261021_001 unsets it from every document.
   */
  availableProviders?: string[];

  /** Pinned provider (null = System Default, the user's default provider). */
  selectedProviderId?: string | null;
  /**
   * How this agent executes tasks it is assigned (CCR-REQ-1). Absent: a Teros
   * agent — a conversation turn. `claude-code`: no LLM core of its own; each
   * task is a Claude Code session in the workspace's terminal host, started
   * by the Claude Code runner (services/terminal/claude-code-runner.ts).
   * @spec CCR-REQ-1
   */
  runner?: 'claude-code';

  /** Pinned model within selectedProviderId (null = provider default). */
  selectedModelId?: string | null;

  /**
   * System capabilities toggles (v1.4.4) — control which auto-provisioned
   * system MCAs (availability.system: true) this agent actually gets.
   *
   * Model: two per-agent lists keyed by mcaId:
   * - `disabledSystemApps`: denylist for default-ON capabilities (memory,
   *   tasks, boards, automate, workflows…). Empty/absent = all ON — the
   *   historical behaviour.
   * - `enabledSystemApps`: allowlist overrides for default-OFF capabilities
   *   (terminal, filesystem, browser, ui — availability.defaultEnabled:
   *   false). Absent = all OFF.
   *
   * A capability is provisioned iff
   *   (defaultEnabled !== false && !disabledSystemApps.includes(mcaId))
   *   || enabledSystemApps.includes(mcaId)
   *
   * `ensureProvisionedApps` reconciles both directions (grants when ON,
   * revokes when OFF — self-healing on re-enable). See
   * docs/specs/agents/20261030_isolated-agents.md for the leak-channel map
   * this generalizes (isolated agent = agent with memory in the denylist).
   */
  disabledSystemApps?: string[];
  enabledSystemApps?: string[];

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
     * System-capability default (v1.4.4): for system MCAs, whether the
     * capability is provisioned to agents by default (true, opt-out via
     * agent.disabledSystemApps) or only when explicitly enabled per agent
     * (false, opt-in via agent.enabledSystemApps — the power capabilities:
     * terminal, filesystem, browser, ui). Absent = true.
     */
    defaultEnabled?: boolean;
    /**
     * Provisioning scope (tn_PcquTN30AawbK8uE): 'super-agents' = the MCA is
     * auto-provisioned only to superagents (agents without workspaceId);
     * workspace agents get it only via an explicit human grant (the grant is
     * the toggle). Absent = no scope restriction (all agents).
     */
    provisions?: {
      scope: 'super-agents';
    };
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
   * Alternative system-secret groups (api-key MCAs with more than one valid
   * credential combination, e.g. mca.teros.email: Stalwart Lab proxy vs
   * direct admin token). When present, 'configured' = ALL non-grouped
   * systemSecrets present AND at least one complete group. `systemSecrets`
   * remains the complete inventory (secret injection, admin UI).
   */
  systemSecretsAny?: string[][];

  /**
   * User-level secrets required (e.g., ['ACCESS_TOKEN', 'REFRESH_TOKEN', 'EMAIL'])
   * These are unique per user, stored encrypted in user_credentials collection
   */
  userSecrets?: string[];

  /**
   * When false, userSecrets are complementary — mandatory even with complete
   * system secrets (e.g. mca.teros.email: MAIL_ACCOUNT is the mailbox
   * identity, not an override of the transport). Absent/true keeps the
   * default api-key semantics (system secrets = valid shared fallback).
   */
  userSecretsOptional?: boolean;

  /**
   * Subset of userSecrets that are individually required (api-key only).
   * Absent = all declared userSecrets are required. Use when some declared
   * user secrets are optional overrides — e.g. mca.teros.email declares
   * MAIL_PASSWORD (overrides the derived password) and MAIL_FROM_NAME
   * (cosmetic) but only requires MAIL_ACCOUNT.
   */
  userSecretsRequired?: string[];

  /**
   * OAuth/Auth configuration from manifest
   */
  auth?: {
    type: 'oauth2' | 'apikey' | 'none' | 'github-app' | 'agent';
    provider?: string;
    // --- Agent-managed auth specific fields ---
    /** Texto mostrado al usuario explicando cómo conectar (pedírselo al agente). */
    instructions?: string;
    // --- OAuth2 specific fields ---
    authorizeUrl?: string;
    tokenUrl?: string;
    scopes?: string[];
    optionalScopes?: string[];
    scopeSeparator?: string;
    pkce?: boolean;
    /**
     * Extra user-configurable fields for OAuth apps.
     * These are stored alongside OAuth tokens but shown as editable inputs in the UI.
     * Example: TEAM_ID in Figma (not obtainable via OAuth but needed for some tools).
     */
    extraFields?: Array<{
      name: string;
      label?: string;
      type?: 'text' | 'password';
      required?: boolean;
      placeholder?: string;
      hint?: string;
    }>;
    // --- GitHub App specific fields ---
    appSlug?: string;
    permissions?: Record<string, 'read' | 'write' | 'admin'>;
    events?: string[];
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

  /** Tools this MCP provides (names only — kept for counts and back-compat) */
  tools: string[];

  /**
   * Tools with their *human* description (jargon stripped) and derived domain
   * `group`, materialised from tools.json during sync (TER-538). Optional and
   * additive: consumers fall back to `tools` (names only).
   */
  toolsDetailed?: Array<{ name: string; description: string; group?: string }>;

  /**
   * Brand accent colours extracted from the icon at sync (TER-538) — the
   * client builds the hero gradient from them. Empty for monochrome logos.
   */
  accentColors?: string[];

  /**
   * Runtime permissions for the detail view (network / filesystem), derived
   * from the execution model at sync (TER-538). Distinct from `auth.permissions`.
   */
  permissions?: Array<{ type: string; label: string; detail: string }>;

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
    | 'other'
    | 'google'
    | 'microsoft';

  /** Icon identifier (lucide icon name) or URL */
  icon?: string;

  /** Brand color for icon background */
  color?: string;

  // --- Catalog presentation (TER-524) — optional, surfaced in the detail view ---
  /** Semantic version (from manifest) */
  version?: string;
  /** Author info (from manifest) */
  author?: { name: string; email?: string; url?: string };
  /** Search keywords / tags */
  keywords?: string[];

  /**
   * Event topics this MCA emits (manifest `events` or the MCA's events.json),
   * served by app.list-event-topics. `filters` (v1.4.4) declares the unified
   * subscription filter fields the backend validates _subscribe filters against.
   */
  events?: Array<{
    topic: string;
    description?: string;
    payload?: Record<string, string>;
    filters?: Record<string, { type: 'string' | 'number' | 'boolean'; operator?: 'anyOf' | 'equals' | 'contains'; mapsTo?: string; description?: string }>;
  }>;

  /** WsRouter actions the MCA may invoke through the WS bridge (manifest `backend.actions`). */
  backendActions?: string[];
  /**
   * Context prehook (Fase 2 — app context in the prompt, manifest `contextPrehook`):
   * how this app contributes environment context to the system prompt of agents
   * that have it installed. Consumed by model-service.buildSystemPrompt().
   */
  contextPrehook?: MCAContextPrehook;
  /** The MCA may open MCA streams (manifest `layers.streams`, spec MCS-REQ-1). */
  streams?: boolean;
  /** Functional dependencies on other catalog MCAs (manifest `dependencies`) — the install UI warns when unsatisfied. */
  dependencies?: string[];
  /** Logo/avatar image URL */
  image?: string;
  /** Background/hero image URL */
  backgroundImage?: string;
  /** Short one-liner for the detail hero */
  tagline?: string;
  /** Screenshot / preview image URLs */
  screenshots?: string[];
  /** Release notes for the changelog section */
  changelog?: Array<{ version: string; date: string; notes: string }>;
  /** Verified/official publisher badge */
  verified?: boolean;
  /** Homepage / docs URL */
  homepage?: string;

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
    /**
     * If true, a persistent directory is mounted into the container at /app-data.
     * The host path is {workspaceHostPath}/.apps/{app.name}/ — scoped per app instance.
     */
    appDataMount?: boolean;
    /**
     * If true, the owner's workspace volume is bind-mounted read-write at
     * /workspace. Grants the MCA full access to the user's workspace files.
     */
    workspaceMount?: boolean;
    /**
     * Container resource limits (Docker --cpus / --memory). When omitted, the
     * backend-wide defaults apply (MCA_CONTAINER_CPUS / MCA_CONTAINER_MEMORY_MB).
     */
    resources?: {
      cpus?: number;
      memoryMb?: number;
    };
  };

  /**
   * MCA-level translations extracted from mcas/<mca-id>/i18n/*.json files.
   * Keys are locale codes (e.g., 'en', 'es', 'ko'). Each value mirrors the
   * structure of the English source (name, description, tagline, changelog,
   * tools with name/description/params). Generated by generate-mca-i18n.ts
   * and loaded during sync-mcas.
   */
  i18n?: Record<string, {
    name?: string;
    description?: string;
    tagline?: string;
    changelog?: Array<{ notes: string }>;
    tools?: Record<string, {
      name?: string;
      description?: string;
      params?: Record<string, string>;
    }>;
  }>;

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
/**
 * Invitation state — stored on the member entry, workspace-scoped.
 * Only present for pending/invited members (not for direct active adds).
 */
export interface InvitationState {
  /** userId of the inviter */
  invitedBy: string;
  /** ISO timestamp of the initial invitation */
  invitedAt: string;
  /** Opaque token embedded in the email CTA (NOT an access credential) */
  token: string;
  /** History of email sends (initial + resends), ISO timestamps */
  sentAt: string[];
  /** Set when membership activates on signup */
  acceptedAt?: string;
  /** Set when the invitation is revoked */
  cancelledAt?: string;
}

/**
 * Workspace member — active or pending.
 *
 * Active members have `userId` set and full workspace access.
 * Pending members are keyed by `email` (no userId), have zero access,
 * and activate automatically when someone creates an account with that email.
 *
 * Backward compatibility: existing entries without `status` are treated as
 * 'active'; entries without `invitation` were never invited (direct add).
 */
export interface WorkspaceMember {
  /** User ID — absent while status === 'pending' */
  userId?: string;
  /** Member role (owner is implicit, never listed as a member) */
  role: 'admin' | 'write' | 'read';
  /** When the member joined (set on activation or immediately for active adds) */
  joinedAt: string;
  /** userId who added/invited this member */
  addedBy: string;

  // ── MUW-14: Invitations & pending membership ──────────────────────────

  /** 'active' (default, backward compat) or 'pending' (invited, no account yet) */
  status?: 'active' | 'pending';
  /** Normalized lowercase email — key for pending members */
  email?: string;
  /** Invitation state (only for pending/invited entries) */
  invitation?: InvitationState;
}

export interface Workspace {
  /** Unique identifier (e.g., "work_teros-v2", "work_hexagon") */
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
   * Workspace settings
   */
  settings: {
    /** Default git branch for dev workspaces */
    defaultBranch?: string;
    /**
     * Zero Data Retention only — when true, model selection is restricted to
     * models whose resolved retention tier is `zdr` (local Ollama models,
     * ZDR-by-contract providers, or models marked `providerConfig.zdr`).
     * The picker hides everything else; the backend also refuses to resolve a
     * non-ZDR model for agents in this workspace (defense in depth).
     */
    zdrOnly?: boolean;
    /**
     * 🛡️ Teros Guard (docs/specs/security/20261106_teros-guard.md): per-workspace
     * switch for the review layer over `allow` calls. The GLOBAL rollout switch
     * is the feature flag `tools.teros-guard` — both must be ON for the guard
     * to run. `apps` empty/absent = the conservative default watch list
     * (bash, http, email, payments — see mca-tool-executor DEFAULT_GUARD_APPS).
     */
    terosGuard?: {
      enabled: boolean;
      apps?: string[];
    };
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

  /**
   * Workspace type
   * - 'private': Auto-created for each user on registration. Cannot be deleted.
   * - 'shared': Regular user-created workspace (default for existing workspaces).
   */
  type?: 'private' | 'shared';

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
/** @spec NAV-REQ-2 */
export type NavbarPinScope = 'workspace' | 'personal';
/** @spec NAV-REQ-2 — a window serialized by its definition (`serialize(props)`). */
export interface NavbarPinWindow {
  type: string;
  props: Record<string, unknown>;
}
/**
 * One anchored window of the navbar (NAV spec v2.0.0). Workspace-scope pins are
 * shared by every member; personal pins belong to `userId` and are local to
 * `workspaceId` unless `global` (then `workspaceId` is the user's private workspace).
 * @spec NAV-REQ-2
 */
export interface NavbarPin {
  pinId: string;
  workspaceId: string;
  scope: NavbarPinScope;
  userId?: string;
  global?: boolean;
  window: NavbarPinWindow;
  /** `type` + serialized props, for deduplication. */
  key: string;
  label?: string;
  /** i18n key, used by factory pins. */
  labelKey?: string;
  /** Phosphor icon name; the window definition's `phIcon` when absent. */
  icon?: string;
  display: 'row' | 'widget';
  enabled: boolean;
  order: number;
  factory: boolean;
  createdBy: { kind: 'user' | 'agent' | 'system'; id: string };
  createdAt: string;
  updatedAt: string;
}

export interface App {
  /** Unique identifier (e.g., 'app_abc123') */
  appId: string;

  /** Reference to MCA catalog (foreign key to mca_catalog.mcaId) */
  mcaId: string;

  /**
   * Owner of this app instance — always a workspaceId
   */
  ownerId: string;

  /**
   * Type of owner — always 'workspace' (all apps are workspace-scoped)
   */
  ownerType?: 'workspace';

  /**
   * The member who installed the app — its owner (MUW-REQ-10). Permanent and
   * REQUIRED: migration 20261102_002 backfilled every existing app with the
   * workspace owner; the code never infers an owner from a missing field.
   * @spec MUW-REQ-10
   */
  installedBy: string;

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
   * How this app's tools reach the LLM context window while the
   * `tools.execution-proxy` feature flag is ON (with the flag off, everything
   * is direct and this field is ignored).
   * - unset / 'proxy' (default): tools are NOT listed individually; the agent
   *   discovers them via `list-app-tools` and runs them via `execute-tool`.
   * - 'direct': per-app opt-out — every tool listed individually in the
   *   agent's tool list, like the pre-proxy behavior.
   * Context-budget mechanism only — the permission gate is identical on both paths.
   */
  toolExposure?: 'direct' | 'proxy';

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

  /**
   * App scope — controls credential isolation and usage in shared conversations.
   * - 'personal': per-user credentials, blocked in shared conversations (REQ-7)
   * - 'shared': workspace-level credentials, usable in all conversations
   *
   * Default: 'personal'. Existing apps without this field are treated as 'personal'.
   */
  /**
   * REQUIRED (MUW-REQ-11): 'personal' = only installedBy sees and uses it;
   * 'shared' = the whole workspace. Backfilled by migration 20261102_002.
   */
  scope: 'personal' | 'shared';

  /**
   * Per-user authentication data for personal apps.
   * Keyed by userId, each value is that user's auth credentials (OAuth tokens, API keys, etc.).
   * Only used when scope is 'personal'; shared apps use the top-level `auth` field.
   *
   * Note: the decision to use a separate `app_user_auth` collection is deferred to
   * the per-user credentials task. This type is declared here for forward compatibility.
   */
  userAuth?: Record<string, Record<string, any>>;

  /** App status */
  status?: 'active' | 'disabled';

  /** Metadata */
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// APP_USER_AUTH COLLECTION — per-user credentials for personal apps (REQ-11, NFR-4)
// ============================================================================

/**
 * Per-user authentication credentials for personal apps.
 *
 * Personal apps (scope='personal') store each user's OAuth tokens in this
 * separate collection rather than in `app.auth` (which is workspace-level).
 * This ensures credential isolation: a user's tokens are never read by another
 * user's tool execution (Security Considerations).
 *
 * Unique index: `{ appId: 1, userId: 1 }` — O(1) lookup by userId (NFR-4).
 */
export interface AppUserAuth {
  /** App instance ID (foreign key to apps.appId) */
  appId: string;

  /** User ID — the channel creator whose credentials these are */
  userId: string;

  /**
   * Legacy plaintext OAuth credentials. Replaced by `enc` (SEC-4); removed
   * when the record is next read or written, and by migration 20261017_008.
   */
  auth?: Record<string, any>;

  /** OAuth credentials encrypted with the user's key, AAD app_user_auth:<appId> */
  enc?: { data: string; iv: string; tag: string };
  encryptionFormat?: number;
  /** Incremented on every write; merge() writes conditioned on it (MOD-6) */
  rev?: number;

  updatedAt: string;
  createdAt: string;
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
// AGENT MAILBOXES COLLECTION (mca.teros.email lifecycle — tn_PcquTN30AawbK8uE)
// ============================================================================

/**
 * AgentMailbox — the mailbox auto-provisioned for an agent when the email app
 * is granted to it. ONE mailbox per agent (unique index on agentId); the
 * address is globally unique too (unique index, never reassigned after burn).
 *
 * Written by the grantAccess hook (mca-service) and the lazy safety-net;
 * read by the runtime credential injection (mca-manager.spawn-impl) to
 * resolve the agent's MAIL_ACCOUNT without a per-user user-secret.
 */
export interface AgentMailbox {
  /** Agent that owns this mailbox (unique — one mailbox per agent). */
  agentId: string;

  /** Full address, e.g. 'nira@agents.teros.ai' or 'chen-marcos@agents.teros.ai'. */
  address: string;

  /** Stalwart internal account id (x:Account id) — needed for rename/alias ops. */
  stalwartAccountId?: string;

  /** Display name for outgoing mail (agent's fullName at provision time). */
  fromName?: string;

  /** Stalwart domainId of the mailbox (e.g. 'c' = agents.teros.ai). */
  domainId: string;

  /** Provisioning state: pending = Stalwart call failed, retry pending. */
  status: 'active' | 'pending' | 'renamed';

  /** Addresses this mailbox had before renames (kept alive as aliases). */
  renamedFrom?: string[];

  /** Last provisioning error (when status = 'pending'). */
  lastError?: string;

  /** Provisioning attempts (when status = 'pending'). */
  attempts?: number;

  createdAt: string;
  updatedAt: string;
}

/**
 * BurnedAddress — addresses of deleted mailboxes, never reassigned
 * (no-recycling rule, Pablo 1-nov). Written when a mailbox is destroyed.
 */
export interface BurnedAddress {
  /** The burned address (unique). */
  address: string;

  /** The agent that owned it before deletion (audit trail). */
  agentId: string;

  /** The agent's owner (audit trail). */
  ownerId?: string;

  burnedAt: string;
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

/**
 * Agent Project Relationship - Links an agent to a project with autoplay config
 */
export interface AgentProjectRelationship {
  /** Agent involved in this relationship */
  agentId: string;

  /** Project this relationship belongs to */
  projectId: string;

  /** Number of parallel execution slots (0 = autoplay disabled) */
  slots: number;

  /** Whether autoplay is currently active for this agent in this project */
  playEnabled: boolean;
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
 * Board configuration
 */
export interface BoardConfig {
  // Reserved for future configuration options
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

  /** Workspace of the project (shard key). Optional: boards created before 2026-10-17 lack it */
  workspaceId?: string;

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
/**
 * A typed value attached to a task: its input or its deliverable.
 * See docs/specs/tasks/artifacts.md.
 */
export interface TaskArtifact {
  /** Artifact type (`artifacts` collection) — null when untyped. `"markdown"` is the built-in free-text type. */
  schemaId: string | null;
  /** Snapshot of the type's schema at creation time (form-first ArtifactSchema), so UI and agents render without a lookup. */
  schema?: Record<string, unknown>;
  /** The value. Input: set at creation. Output: set on save / complete. */
  data?: unknown;
}

/**
 * A single-flight review claim on a task, held by one session of one agent.
 * See `Task.reviewClaim` for the full design rationale.
 */
export interface ReviewClaim {
  /** Agent that holds the claim */
  agentId: string;

  /**
   * Channel (= conversation session) that holds the claim. This is the
   * session identifier available in the MCA tool-call path — the WS
   * `sessionId` never reaches the tool context, but `channelId` does
   * (via `ActiveConnection.currentChannelId`).
   */
  channelId: string;

  /** ISO timestamp when the claim was acquired */
  claimedAt: string;

  /** ISO timestamp when the claim expires and becomes stealable */
  expiresAt: string;
}

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

  /** Task description (plain text, max ~1000 chars) */
  description?: string;

  /** Task instructions (full markdown — detailed specs, context, steps) */
  instructions?: string;

  /** Priority level */
  priority: TaskPriority;

  /** Whether this task has been archived (out of the active board) */
  archived: boolean;

  /** Optional note explaining why the task was archived */
  archiveNote?: string;

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

  /**
   * Consecutive autoplay re-wakes WITHOUT progress (TER-650/G2). Incremented on
   * each `_rewakeTask`, reset to 0 whenever the task actually advances (column
   * move or progress note — NOT the per-turn `running` toggle). When it reaches
   * the cap the task is moved to `blocked` instead of re-woken, so a stuck task
   * can't churn autonomous turns (and bill) forever. System-controlled.
   */
  autoWakeCount?: number;

  /**
   * Consecutive failed autoplay STARTS (TODOAP-REQ-32). Incremented on each
   * start that fails (the roll-back write), reset by every state transition,
   * progress note and successful start. When it reaches the cap the task is
   * moved to `blocked` with the error as the reason — a failed start never
   * becomes a silent retry loop. System-controlled.
   */
  startFailCount?: number;

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

  // --------------------------------------------------------------------------
  // Stop signal (cooperative stop mechanism — §6 of board-supervision spec)
  // --------------------------------------------------------------------------

  /**
   * When true, the assigned runner agent should finish its current step and stop.
   * Set by board.stop-task; cleared automatically when the agent moves/updates the task.
   */
  stopRequested?: boolean;

  /** ISO timestamp when the stop was requested */
  stopRequestedAt?: string;

  /** agentId or userId that requested the stop */
  stopRequestedBy?: string;

  // --------------------------------------------------------------------------
  // Review claim (single-flight anti-duplicate — see docs/specs/20261019_single-flight-review-claims.md)
  // --------------------------------------------------------------------------

  /**
   * Atomic claim for review actions on this task, scoped per agent.
   *
   * When multiple concurrent sessions of the SAME agent react to the same
   * board event (e.g. task_moved → Review), only ONE session may hold the
   * claim and execute the review actions (post review note + move column).
   * The others see the live claim and skip (logged as 'skipped: claimed by
   * session X').
   *
   * The claim is acquired via an atomic `findOneAndUpdate` with a conditioned
   * filter — Mongo's atomicity IS the mutex. It expires after a TTL
   * (default 15 min, env BOARD_REVIEW_CLAIM_TTL_MS) so a dead session's claim
   * can be stolen by a live one.
   *
   * Released when the review's terminal action (the column move) completes,
   * or by expiry. Per (taskId, agentId) — different agents have independent
   * claims on the same task (AC-3: multi-agent flow unaffected).
   *
   * Stored as a map keyed by agentId so each agent holds its own claim.
   */
  reviewClaims?: Record<string, ReviewClaim>;

  // --------------------------------------------------------------------------
  // Workflow extensions (§WF2 — workflow task integration)
  //
  // These fields are set when a task is created by the workflow engine.
  // They allow the engine to validate task output against a gate, link the
  // task back to its execution and node, and track input/output data.
  //
  // The backend stores them as opaque JSON — the workflow engine owns
  // validation logic. See @teros/workflows WorkflowTaskExtensions.
  // --------------------------------------------------------------------------

  /** Input gate — routing metadata of the workflow node (gateId, schemaId, label) */
  workflowInputGate?: Record<string, unknown>;

  /** Output gate — routing metadata of the workflow node (gateId, schemaId, label) */
  workflowOutputGate?: Record<string, unknown>;

  // --------------------------------------------------------------------------
  // Artifacts (docs/specs/tasks/artifacts.md) — owned by the task itself.
  // The workflow engine, Automate, humans and agents all read/write these;
  // the workflow* fields above are only the engine's routing linkage.
  // --------------------------------------------------------------------------

  /** What the task receives (event payload, upstream gate data, …). */
  input?: TaskArtifact;

  /** What the task delivers (form answers, report, structured output, …). */
  output?: TaskArtifact;

  /** Reference to the workflow execution that created this task (foreign key to executions.executionId) */
  workflowExecutionId?: string;

  /** Reference to the workflow node that created this task (matches WorkflowNode.nodeId) */
  workflowNodeId?: string;

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
/**
 * Who is looking at an agent's apps: a member (visibility) and, inside a
 * conversation, that conversation's creator + scope (MUW-REQ-12).
 * @spec MUW-REQ-12
 */
export interface AppViewer {
  userId: string;
  channelScope?: 'personal' | 'shared';
}

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

  /**
   * FK to `agent_usage_sessions.sessionUsageId` — present when this LLM call
   * happened inside an instrumented turn. Allows grouping all the LLM calls of
   * a multi-step turn under the same session. Sparse index `{sessionUsageId:1}`.
   * Optional and additive — legacy rows without it are valid.
   */
  sessionUsageId?: string;

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
    | 'ollama'
    | 'ollama-cloud'
    | 'openai-compatible'
    | 'helmcode';

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

  /**
   * Real upstream provider that served the request (`fireworks` | `together` |
   * `cloudflare` | …). Distinct from the logical `provider` (e.g. `teros`):
   * lets observability tell Fireworks from Together even when the logical
   * provider is identical. Populated by the OpenAI-compatible adapter
   * (TER-615 / gap C1). Absent for providers without an upstream split.
   */
  actualProvider?: string;

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

  /** Time-to-first-token in milliseconds (client-side wall clock). TER-615. */
  ttftMs?: number;

  /** True if this turn failed over Fireworks→Together (TER-617/F3). */
  fallbackUsed?: boolean;
  /** When `fallbackUsed`, the errorClass that made Fireworks fail (preserved for error-rate). */
  primaryErrorClass?: string;

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

// ============================================================================
// SKILLS COLLECTION
// ============================================================================

/**
 * Skill - A reusable block of instructions/knowledge for agents
 *
 * Skills are workspace-scoped resources that can be assigned to multiple agents.
 * They are injected into the agent's system prompt at conversation time.
 * Content supports Markdown and {{variable}} interpolation (e.g., {{agent.name}}).
 */
export interface Skill {
  /** Unique identifier (e.g., "sk_a1b2c3d4e5f6g7h8") */
  skillId: string;

  /** Workspace this skill belongs to */
  workspaceId: string;

  /** Human-readable name, unique within the workspace */
  name: string;

  /** Short description of what this skill does */
  description?: string;

  /**
   * Markdown content of the skill, injected into the system prompt.
   * Supports {{variable}} interpolation:
   * - {{agent.name}}, {{agent.fullName}}, {{agent.role}}, {{agent.intro}}, {{agent.email}}
   * - {{workspace.name}}
   */
  content: string;

  /**
   * Loading mode for this skill.
   * - 'always': Content is always injected into the system prompt (legacy behavior).
   * - 'on-demand': Only name+description appear in the index; content is loaded per-request.
   * Defaults to 'on-demand' for new skills; existing skills migrated to 'always'.
   */
  loadMode?: 'always' | 'on-demand';

  /**
   * Optional category for organization
   * - 'development': Coding, git, CI/CD
   * - 'communication': Style, tone, language
   * - 'domain-knowledge': Business/domain-specific knowledge
   * - 'security': Security policies and practices
   * - 'workflow': Process and workflow definitions
   */
  category?: 'development' | 'communication' | 'domain-knowledge' | 'security' | 'workflow';

  /** Optional tags for search and categorization */
  tags?: string[];

  /** User who created this skill */
  createdBy: string;

  /** Metadata */
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// AGENT SKILL ACCESS COLLECTION
// ============================================================================

/**
 * Agent Skill Access - Assignment of a skill to an agent
 *
 * Models the many-to-many relationship between agents and skills.
 * Follows the same pattern as AgentAppAccess.
 * A skill can be disabled per-agent without removing the assignment.
 */
export interface AgentSkillAccess {
  /** Agent that has this skill assigned (foreign key to agents.agentId) */
  agentId: string;

  /** Skill assigned (foreign key to skills.skillId) */
  skillId: string;

  /** Workspace (denormalized for efficient queries) */
  workspaceId: string;

  /**
   * Whether the skill is active for this agent.
   * Skills with enabled=false are assigned but not injected into the prompt.
   */
  enabled: boolean;

  /**
   * Injection order in the system prompt (lower = earlier).
   * Skills are sorted by this value when building the prompt.
   */
  order: number;

  /** Who granted this skill access */
  grantedBy: string;

  /** When this assignment was created */
  grantedAt: string;
}

// ============================================================================
// BOARD SUBSCRIPTIONS
// ============================================================================

/**
 * Board event types — emitted by BoardEventEmitter and delivered to subscribers.
 * Named as {context}.{artifact}_{action} for easy migration to generic MCA events.
 */
export type BoardEventType =
  | 'board.task_moved'
  | 'board.task_archived'
  | 'board.task_assigned'
  | 'board.task_created'
  | 'board.task_updated'
  | 'board.task_progress_note'
  | 'board.agent_play_changed'
  | 'board.agent_slots_changed'
  | 'board.dependency_added'
  | 'board.dependency_removed';

/**
 * Filter for a board subscription.
 * All fields are optional — an empty filter matches all events.
 * Multiple fields are AND-ed; multiple values within a field are OR-ed.
 *
 * NOTE: Kept flat (not nested under `metadata`) so migration to generic
 * SubscriptionFilter.metadata is a simple rename — see SUBSCRIPTIONS-AND-MCA-ARTIFACTS.md §5.1
 */
export interface BoardSubscriptionFilter {
  /** Only events where the task is assigned to one of these agents */
  agentIds?: string[];
  /** Only events where the task is in one of these columns */
  columnIds?: string[];
  /** Only tasks that have ALL of these tags */
  tags?: string[];
  /** Only events for these specific tasks (by taskId) */
  taskIds?: string[];
  /** Only these event types */
  eventTypes?: BoardEventType[];
  /** Event types that wake the subscribed agent (trigger a response turn) */
  wakeUpOn?: BoardEventType[];
}

/**
 * A board subscription — links a conversation channel to a board.
 * The channel receives board events filtered by `filter`.
 *
 * Collection: board_subscriptions
 * Indexes:
 *   { boardId: 1 }                       — find all subscribers of a board
 *   { channelId: 1 }                      — manage subscriptions from a channel
 *   { boardId: 1, channelId: 1 } unique   — prevent duplicates
 *
 * Migration path → mca_subscriptions: rename boardId → mcaId+filter.metadata.boardId
 * See SUBSCRIPTIONS-AND-MCA-ARTIFACTS.md §5.1
 */
export interface BoardSubscription {
  /** Unique ID, e.g. "bsub_xxx" */
  subscriptionId: string;
  /** Board being watched */
  boardId: string;
  /** Conversation that receives the events */
  channelId: string;
  /** Agent that owns the subscribed conversation */
  agentId: string;
  /** Optional filter — empty = receive all events */
  filter: BoardSubscriptionFilter;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// TODO LIST EVENTS & SUBSCRIPTIONS (parity with the board — docs/specs/todo/events.md)
// ============================================================================

/**
 * Event types of the to-do list, published under the `todo.` namespace on the
 * MCA event bus (`todo.task_created` …) and delivered to subscribed
 * conversations. Board↔todo mapping:
 *
 *   board.task_created       → todo.task_created
 *   board.task_moved         → todo.task_state_changed (+ granular task_started/
 *                              task_completed/task_blocked) and todo.task_moved
 *                              (reparenting)
 *   board.task_assigned      → todo.task_assigned / todo.task_unassigned
 *   board.task_updated       → todo.task_updated
 *   board.task_progress_note → todo.task_progress (log entries + set-progress)
 *   board.task_archived      → todo.task_deleted
 *   board.agent_play_changed → todo.agent_play_changed
 *   board.agent_slots_changed→ todo.agent_slots_changed
 *   (no board equivalent)    → todo.task_planned, todo.task_output_delivered
 */
export type TodoEventType =
  | 'task_created'
  | 'task_started'
  | 'task_completed'
  | 'task_blocked'
  | 'task_state_changed'
  | 'task_assigned'
  | 'task_unassigned'
  | 'task_planned'
  | 'task_output_delivered'
  | 'task_progress'
  | 'task_updated'
  | 'task_moved'
  | 'task_deleted'
  | 'agent_play_changed'
  | 'agent_slots_changed'
  | 'global_play_changed'
  | 'dependency_added'
  | 'dependency_removed';

/**
 * Filter for a to-do subscription.
 * All fields are optional — an empty filter matches all events.
 * Multiple fields are AND-ed; multiple values within a field are OR-ed.
 *
 * Kept flat for the same migration reason as BoardSubscriptionFilter.
 */
export interface TodoSubscriptionFilter {
  /** Only events for these specific tasks (by nodeId) — "avísame cuando ESTA acabe" */
  nodeIds?: string[];
  /** Only events where the task is assigned to one of these agents/users */
  assigneeIds?: string[];
  /** Only events where the task's reviewer is one of these agents/users (TODORV) */
  reviewerIds?: string[];
  /** Only events where the task's NEW state is one of these */
  states?: string[];
  /** Only events for tasks inside these groups' subtrees (by group nodeId) */
  groupNodeIds?: string[];
  /** Only these event types (TodoEventType values) */
  eventTypes?: TodoEventType[];
  /** Event types that wake the subscribed agent (trigger a response turn) */
  wakeUpOn?: TodoEventType[];
}

/**
 * Workspace-level Tasks autoplay global play/pause state (TODOAP-REQ-30).
 *
 * One document per workspace in `todo_autoplay_state`. A MISSING document
 * means `playing` — the default, so workspaces that never touched the global
 * control keep working exactly as before. Only a deliberate pause writes the
 * doc (`playing: false`); resuming deletes it (back to the default).
 *
 * The two-level model (Pablo, 2026-10-30):
 *   - global: playing / paused — the panel's Play/Pause control;
 *   - per-runner: playEnabled (config) + slots;
 *   - a runner only works iff global=playing ∧ runner=playEnabled ∧ slots≥1.
 */
export interface TodoAutoplayState {
  /** Workspace this global state belongs to */
  workspaceId: string;
  /** false = paused (the only reason the doc exists); true never stored */
  playing: boolean;
  updatedAt: Date;
}

/**
 * A to-do subscription — links a conversation channel to a workspace's task
 * tree. The channel receives to-do events filtered by `filter`.
 *
 * Collection: todo_subscriptions
 * Indexes:
 *   { workspaceId: 1 }                    — find all subscribers of a workspace
 *   { channelId: 1 }                      — manage subscriptions from a channel
 *   { workspaceId: 1, channelId: 1 } unique — prevent duplicates
 */
export interface TodoSubscription {
  /** Unique ID, e.g. "tsub_xxx" */
  subscriptionId: string;
  /** Workspace whose task tree is watched */
  workspaceId: string;
  /** Conversation that receives the events */
  channelId: string;
  /** Agent that owns the subscribed conversation */
  agentId: string;
  /** Optional filter — empty = receive all events */
  filter: TodoSubscriptionFilter;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// BOARD EVENTS COLLECTION (unified activity feed)
// ============================================================================

/**
 * Board Event — a single activity event on a board.
 *
 * Replaces the embedded `activity: TaskActivityEntry[]` array on Task documents.
 * Each event is its own document, enabling efficient pagination, filtering by
 * board/project/workspace, and TTL-based retention without unbounded document growth.
 *
 * Collection: board_events
 * Indexes:
 *   { boardId: 1, timestamp: -1 }              — chronological feed per board
 *   { taskId: 1, timestamp: -1 }               — activity history per task
 *   { projectId: 1, timestamp: -1 }            — project-level activity
 *   { workspaceId: 1, timestamp: -1 }           — workspace-wide feed
 *   { eventType: 1, timestamp: -1 }             — filter by event type
 *   { actor: 1, timestamp: -1 }                 — filter by actor
 *   { timestamp: 1 }, { expireAfterSeconds }    — TTL for retention
 */
export interface BoardEvent {
  /** Unique event ID, e.g. "bevt_xxx" */
  eventId: string;

  /** Board where the event occurred */
  boardId: string;

  /** Project that owns the board (denormalized for efficient queries) */
  projectId: string;

  /** Workspace that owns the project (denormalized for efficient queries) */
  workspaceId: string;

  /** Task involved in the event (null for board-level events like agent_play_changed) */
  taskId: string | null;

  /** Task title at the time of the event (denormalized for feed display) */
  taskTitle: string | null;

  /** Event type — same vocabulary as TaskActivityEventType + BoardEventType */
  eventType: BoardEventCategory;

  /** Who performed the action (userId, agentId, or 'system' / 'system:autoplay') */
  actor: string;

  /** When the event occurred (ISO 8601) */
  timestamp: string;

  /** Event-specific details (same shape as TaskActivityEntry.details, extended) */
  details?: BoardEventDetails;
}

/**
 * Unified event type vocabulary.
 * Combines TaskActivityEventType (structural changes) and BoardEventType (subscription events).
 * The first column ('task.*') are the granular structural events that replace the old
 * embedded activity array. The second column ('board.*') are the subscription-level events.
 */
export type BoardEventCategory =
  // Task structural events (from TaskActivityEventType)
  | 'task.created'
  | 'task.moved'
  | 'task.assigned'
  | 'task.unassigned'
  | 'task.started'
  | 'task.linked'
  | 'task.priority_changed'
  | 'task.updated'
  | 'task.deleted'
  | 'task.archived'
  | 'task.unarchived'
  | 'task.progress_note'
  | 'task.running_changed'
  | 'task.dependency_added'
  | 'task.dependency_removed'
  | 'task.circular_dependency_detected'
  | 'task.blocked'
  | 'task.completed'
  | 'task.cancelled'
  | 'task.stop_requested'
  // Board-level events (from BoardEventType, kept for subscription compatibility)
  | 'board.task_moved'
  | 'board.task_archived'
  | 'board.task_assigned'
  | 'board.task_created'
  | 'board.task_updated'
  | 'board.task_progress_note'
  | 'board.agent_play_changed'
  | 'board.agent_slots_changed'
  | 'board.dependency_added'
  | 'board.dependency_removed';

/**
 * Event details — extended from TaskActivityEntry.details with additional fields.
 * Not all fields are set for all event types; consumers check by eventType.
 */
export interface BoardEventDetails {
  fromColumn?: string;
  toColumn?: string;
  fromColumnName?: string;
  toColumnName?: string;
  agentId?: string;
  channelId?: string;
  oldPriority?: string;
  newPriority?: string;
  field?: string;
  fromStatus?: string;
  toStatus?: string;
  note?: string;
  running?: boolean;
  slots?: number;
  playEnabled?: boolean;
  dependsOnTaskId?: string;
  tags?: string[];
  assignedAgentId?: string;
  archiveNote?: string;
  [key: string]: unknown;
}

// ============================================================================
// BOARD DAILY STATS COLLECTION (aggregated metrics per board per day)
// ============================================================================

/**
 * Board Daily Stats — aggregated metrics for a board on a specific day.
 *
 * One document per board per UTC day. Updated incrementally as events arrive
 * (using $inc and $push to a capped array for recent activity highlights).
 *
 * Collection: board_daily_stats
 * Indexes:
 *   { boardId: 1, date: 1 } unique   — one doc per board per day
 *   { projectId: 1, date: -1 }        — project-level trend queries
 *   { workspaceId: 1, date: -1 }      — workspace-level dashboard
 *   { date: -1 }                       — cross-board daily queries
 */
export interface BoardDailyStats {
  /** Unique ID, e.g. "bds_xxx" */
  statsId: string;

  /** Board these stats belong to */
  boardId: string;

  /** Project that owns the board (denormalized) */
  projectId: string;

  /** Workspace that owns the project (denormalized) */
  workspaceId: string;

  /** The UTC calendar day this stats document covers (YYYY-MM-DD) */
  date: string;

  // --- Task counts by column (snapshot at end of day) ---
  /** Number of tasks in each column at the end of this day */
  columnCounts: Record<string, number>;

  // --- Flow metrics (cumulative for the day) ---
  /** Tasks created during the day */
  tasksCreated: number;
  /** Tasks moved during the day (total moves, not unique tasks) */
  tasksMoved: number;
  /** Tasks completed (moved to Done) during the day */
  tasksCompleted: number;
  /** Tasks blocked (moved to Blocked) during the day */
  tasksBlocked: number;
  /** Tasks archived during the day */
  tasksArchived: number;
  /** Tasks started (moved to In Progress) during the day */
  tasksStarted: number;
  /** Progress notes posted during the day */
  progressNotesPosted: number;
  /** Dependencies added during the day */
  dependenciesAdded: number;
  /** Dependencies removed during the day */
  dependenciesRemoved: number;

  // --- Agent activity ---
  /** Distinct agents that were active on this board during the day */
  activeAgents: string[];
  /** Agent assignments made during the day */
  assignmentsMade: number;
  /** Agent unassignments made during the day */
  unassignmentsMade: number;

  // --- Recent activity highlights (capped array, last N events) ---
  /** Up to 20 most recent event IDs for quick preview (oldest first, $slice) */
  recentEventIds: string[];

  /** When this stats document was first created */
  createdAt: string;
  /** When this stats document was last updated */
  updatedAt: string;
}

// ============================================================================
// USER DESKTOP STATE
// ============================================================================

/**
 * Persisted desktop layout state per user per workspace.
 * Stored in the `user_desktop_state` MongoDB collection.
 */
export interface UserDesktopState {
  /** Flat key/value map of all persisted storage keys for this workspace */
  state: Record<string, string>;

  /** userId */
  userId: string;
  /** workspaceId (or 'global' for superagent desktops with no workspace) */
  workspaceId: string;

  /** Last updated timestamp */
  updatedAt: Date;
}

// ============================================================================
// FEATURE FLAGS COLLECTION
// ============================================================================

import type {
  FeatureFlagDefinition,
  FeatureFlagTargetType,
  FeatureFlagValue,
  MCAContextPrehook,
} from '@teros/shared';

export type { FeatureFlagDefinition, FeatureFlagTargetType, FeatureFlagValue };

/**
 * FeatureFlag — A flag definition synced from the code registry to MongoDB.
 *
 * Collection: feature_flags
 * This is the DB mirror of FEATURE_FLAG_REGISTRY from @teros/shared.
 * At startup, the registry is synced: missing flags are created, existing
 * flags have their type/description/category updated if changed.
 *
 * The `defaultValue` in the DB reflects the current registry default.
 * It can be changed via setDefault() without touching the registry.
 */
export interface FeatureFlag extends FeatureFlagDefinition {
  /** ISO timestamp of last sync from registry */
  syncedAt: string;

  /** ISO timestamp of last value change */
  updatedAt: string;

  /**
   * Optional percentage rollout. When set, `resolve()` returns `rollout.value`
   * for ids whose deterministic bucket falls in [0, percentage) — after exact
   * overrides (user/workspace/company) and before the default. `percentage` is
   * an integer 0..100 (0 = off but config retained). Mutable by admin via
   * setRollout(); embedded here (no separate collection). See TER-412.
   */
  rollout?: {
    value: FeatureFlagValue;
    percentage: number;
  };
}

// ============================================================================
// FEATURE FLAG OVERRIDES COLLECTION
// ============================================================================

/**
 * FeatureFlagOverride — Scoped override for a feature flag.
 *
 * Collection: feature_flag_overrides
 * Resolution hierarchy (most specific wins):
 *   user → workspace → company → global (feature_flags.defaultValue)
 *
 * Indexes:
 *   { key: 1, targetType: 1, targetId: 1 } unique
 *   { key: 1 }
 *   { targetType: 1, targetId: 1 }
 */
export interface FeatureFlagOverride {
  /** Feature flag key (e.g., 'voice.enabled') */
  key: string;

  /** Target type: user, workspace, or company */
  targetType: FeatureFlagTargetType;

  /** Target ID (userId, workspaceId, or companyId) */
  targetId: string;

  /** Override value */
  value: FeatureFlagValue;

  /** Optional note explaining why this override exists */
  note?: string;

  /** Who created this override */
  createdBy: string;

  /** ISO timestamp */
  createdAt: string;

  /** ISO timestamp of last update */
  updatedAt: string;
}

// ============================================================================
// FEATURE FLAG AUDIT LOG COLLECTION
// ============================================================================

/**
 * FeatureFlagAuditLog — Immutable record of every change to flags or overrides.
 *
 * Collection: feature_flag_audit_log
 * Indexes:
 *   { key: 1, timestamp: -1 }
 *   { actor: 1, timestamp: -1 }
 *   { timestamp: -1 }
 */
export interface FeatureFlagAuditLog {
  /** Audit entry ID */
  auditId: string;

  /** Feature flag key */
  key: string;

  /** Action performed */
  action:
    | 'set_default'
    | 'reset_default'
    | 'set_override'
    | 'delete_override'
    | 'sync_registry'
    | 'set_rollout'
    | 'clear_rollout'
    | 'apply_rollout';

  /** Who performed the action */
  actor: string;

  /** ISO timestamp */
  timestamp: string;

  /** Previous state (null if new) */
  previousValue?: FeatureFlagValue;

  /** New state */
  newValue?: FeatureFlagValue;

  /** Override target info (for override actions) */
  targetType?: FeatureFlagTargetType;
  targetId?: string;

  /** Optional note */
  note?: string;
}

// ============================================================================
// USER CONSENT AUDIT
// ============================================================================

/**
 * ConsentAuditLog — Immutable record of every user consent change.
 * Same pattern as FeatureFlagAuditLog: who, when, on/off, and the version of
 * the consent copy shown at the time (SOC 2 style audit trail).
 * Written by UserService.setEvaluationConsent (profile.set-evaluation-consent).
 */
export interface ConsentAuditLog {
  /** Audit entry ID */
  auditId: string;

  /** The user whose consent changed */
  userId: string;

  /** Which consent flag changed */
  key: 'evaluation_opt_in';

  /** The change performed */
  action: 'on' | 'off';

  /** Who performed the change (self-service: the user themself) */
  actor: string;

  /** ISO timestamp */
  timestamp: string;

  /** Version of the consent copy shown when the change was made */
  consentVersion: string;
}

// ============================================================================
// AGENT USAGE INSTRUMENTATION COLLECTIONS
// ============================================================================
// New subsystem to measure, per user, tokens + active time per agent /
// provider / model. Reuses LLMResponse.usage capture; persists via event
// sourcing with 6 projections (sessions, tool executions, rollups hourly +
// user_hourly, and an idempotency log).
//
// Design doc: docs/usage-instrumentation.md
// ============================================================================

/**
 * Trigger that initiated an agent turn.
 *
 * Filtered by default to 'user_message' in self-service endpoints to avoid
 * showing autorun/scheduled activity that the user did not directly trigger.
 */
export type AgentUsageTriggerKind =
  | 'user_message'
  | 'delegation'
  | 'autorun'
  | 'scheduled'
  | 'event_subscription';

/**
 * Taxonomy of error kinds. Mapped from `AgentError.type` in `classifyError()`.
 */
export type AgentUsageErrorKind =
  | 'llm_error'
  | 'tool_error'
  | 'session_error'
  | 'validation_error'
  | 'network_error'
  | 'aborted_by_user'
  | 'reconciled_timeout'
  // Degradation buckets mapped from the adapter's `errorClass` (TER-615/F0):
  // they refine the old `llm_error` catch-all so the F1 model-health window can
  // tell a rate-limit storm from a 5xx outage. Additive — legacy rows keep
  // their original kind.
  | 'rate_limited'
  | 'overloaded'
  | 'server_error'
  | 'spend_gate'
  | 'auth_error'
  // A retired/undeployed model (404) — closes the gap where it telemetered as
  // `unknown` (TER-698). Persistent: the user must switch the agent's model.
  | 'model_unavailable'
  | 'unknown';

/**
 * Source of the durationMs measurement.
 * - 'monotonic' — computed with performance.now() in the same process that
 *   started the session (preferred, NTP-safe).
 * - 'wallclock_reconciled' — computed by the reconciler from Date.now()
 *   because the original monoStart was lost (process restart, OOM).
 */
export type AgentUsageDurationSource = 'monotonic' | 'wallclock_reconciled';

/**
 * Session status lifecycle.
 *
 * A session is `queued` from the moment `processAgentResponse` opens it (the
 * turn is enqueued on the ChannelWorker) until the worker actually starts
 * executing it, at which point it flips to `running` with an
 * execution-anchored `startedAt` (TER-650/G1). Billing meters the
 * `[startedAt, endedAt]` execution interval, NOT the queue wait, and the
 * reconciler distinguishes a stuck-queued turn (never ran) from a hung-running
 * one (ran past the turn deadline).
 *
 * Transitions:
 *   queued  → running           (ChannelWorker pulled the item; awaitStart fired)
 *           → timed_out         (reconciler closed a queue-orphan: worker died)
 *           → aborted / errored (turn cancelled/failed before it ever ran)
 *   running → completed         (LLM end_turn, no error)
 *           → errored           (uncaught error in processAgentResponse)
 *           → aborted           (user interrupted with a new message)
 *           → timed_out         (reconciler closed an execution-orphan)
 */
export type AgentUsageSessionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'errored'
  | 'timed_out'
  | 'aborted';

/**
 * Tool execution status lifecycle.
 */
export type ToolExecutionStatus =
  | 'running'
  | 'success'
  | 'error'
  | 'permission_denied'
  | 'aborted';

// ----------------------------------------------------------------------------
// Event payloads (discriminated by AgentUsageEvent.type)
// ----------------------------------------------------------------------------

export interface SessionStartedPayload {
  parentSessionUsageId: string | null;
  /**
   * Root of the delegation tree this turn belongs to (F3a — Latitude OTLP
   * export). For a top-level turn it equals the session's own id; for a
   * delegated child it is inherited from the parent (propagated via
   * AsyncLocalStorage). Denormalized at emit time so the OTLP span export can
   * derive a stable, tree-wide `traceId` without walking the ancestor chain.
   * Optional + additive: events emitted before F3a fall back to the session id.
   */
  rootSessionUsageId?: string;
  triggerKind: AgentUsageTriggerKind;
  userId: string;
  agentId: string;
  workspaceId: string;
  channelId: string;
  coreId?: string;
  provider: LLMUsage['provider'];
  modelId: string;
  /**
   * Expected upstream that will serve the turn (`fireworks` | `together` | …),
   * pre-computed at start so error/timeout turns — which never emit
   * `session.delta` — still bucket under the real upstream instead of the
   * logical `provider` alias (TER-616/C1). A successful turn overwrites it via
   * `session.delta.actualProvider` (identical value for `teros`/Fireworks).
   * Absent for providers without an upstream split.
   */
  actualProvider?: string;
  /** Expected actual model string for the same reason. See `actualProvider`. */
  actualModel?: string;
  /** Latency lane of a Teros turn (TLANE-REQ-9). */
  lane?: 'interactive' | 'background';
  /**
   * Enqueue timestamp (when `processAgentResponse` opened the session). The
   * turn is `queued` at this point — NOT yet executing. The applier stores the
   * session with `startedAt=null` and only sets the authoritative
   * execution-anchored `startedAt` from `session.running` (TER-650/G1). Kept
   * here for diagnostics (queue-wait = running.startedAt − this).
   */
  startedAt: Date;
}

/**
 * Emitted when the ChannelWorker pulls the turn out of the queue and starts
 * executing it (surfaced via `ConversationManager` `onTurnStart` ← the worker's
 * `awaitStart`). Flips the session `queued → running` and sets the
 * authoritative `startedAt` that billing meters. TER-650/G1.
 */
export interface SessionRunningPayload {
  /** Wall-clock instant execution actually began. Authoritative billing anchor. */
  startedAt: Date;
}

export interface SessionDeltaPayload {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  llmCallCount: number;
  toolCallCount: number;
  actualModel?: string;
  /** Real upstream provider that served the turn (`fireworks` | `together` | …). TER-615 / C1. */
  actualProvider?: string;
  /** Total LLM wall-clock latency of the turn (ms, summed across steps). TER-615. */
  latencyMs?: number;
  /** Time-to-first-token of the turn's first LLM step (ms, client-side). TER-615. */
  ttftMs?: number;
  /** Provider finish_reason of the turn (stop/length/tool_calls/…) — truncation proxy §3.1. */
  stopReason?: string;
  /** True if the turn failed over Fireworks→Together (TER-617/F3). */
  fallbackUsed?: boolean;
  /** When `fallbackUsed`, the errorClass that made the primary fail. */
  primaryErrorClass?: string;
  /** True if the provider returned a partial/null usage object. */
  usagePartial?: boolean;
  /** True if token counts were estimated locally (provider returned no usage). */
  usageEstimated?: boolean;
  /**
   * Per-category token breakdown for the input side, scaled so that the
   * sum matches the provider's real `inputTokens` (factor correction).
   * Categories: system, tools, examples, memory, summary, conversation,
   * toolCalls (input args), toolResults, plus `output` for assistant
   * tokens. The breakdown is best-effort heuristic (ai-tokenizer 97%+
   * accuracy on the per-text level, normalised on the bucket level).
   *
   * Optional: emitted only when ConversationManager could compute it
   * (depends on `PromptBuilder.breakdown` being available and the LLM
   * response carrying `inputTokens`).
   */
  tokenBreakdown?: SessionTokenBreakdown;
}

/**
 * Per-category token breakdown stored in `AgentUsageSession` and emitted
 * via `session.delta` events. All fields are token counts; the sum of
 * input-side categories ≈ `inputTokens + cachedReadTokens` after
 * factor-of-correction normalisation in `ConversationManager`.
 */
export interface SessionTokenBreakdown {
  /** System prompt: identity, personality, rules. */
  system: number;
  /** MCA tool definitions (descriptions + input_schema JSON). */
  tools: number;
  /** Few-shot examples (if the agent ships any). */
  examples: number;
  /** RAG retrieved knowledge / memory context. */
  memory: number;
  /** Compacted conversation summary (post-compaction synthetic msg). */
  summary: number;
  /** Conversation history (user + assistant text combined). */
  conversation: number;
  /** Tool call inputs (JSON args from the LLM's tool_calls). */
  toolCalls: number;
  /** Tool execution outputs (results returned to the LLM). */
  toolResults: number;
  /** Assistant output (final + intermediate text). */
  output: number;
}

export interface SessionEndedPayload {
  endedAt: Date;
  durationMs: number;
  durationSource: AgentUsageDurationSource;
  /**
   * True when the turn was killed by the absolute turn deadline
   * (`OperationTimeoutError` with operation 'turn-deadline', TER-650) — the
   * recorded `durationMs` is then "elapsed until the watchdog killed the
   * turn", NOT real agent work. Reporting must exclude/adjust these sessions
   * (same convention as the legacy range [1_795_000–1_805_000]). Absent on
   * every other close — including reconciled timeouts, which already carry
   * `durationSource: 'wallclock_reconciled'` + `errorKind:
   * 'reconciled_timeout'`.
   */
  durationCapped?: boolean;
  /** Terminal status only — a session never ends `queued` or `running`. */
  status: Exclude<AgentUsageSessionStatus, 'running' | 'queued'>;
  errorKind?: AgentUsageErrorKind;
  /** Sanitized via sanitizeErrorMessage() and truncated to 1k chars. */
  errorMessage?: string;
  /**
   * Honest-attribution sub-reason from the adapter (TER-698): `provider_capacity`
   * / `account_rate_limit` / `token_rate_limit` / `provider_billing` /
   * `model_unavailable` / `provider_overloaded` / `provider_server_error` /
   * `auth`. Ops-only (drives the upstream-errors feed + alerts); never shown to
   * the user. A safe enum string, not sanitized.
   */
  errorSubReason?: string;
  /**
   * The literal upstream provider message (TER-698), preserved verbatim for the
   * ops feed / session-detail. Sanitized via sanitizeErrorMessage() and
   * truncated to 1k chars. Never rendered raw to the end user.
   */
  upstreamMessage?: string;
  /**
   * Denormalized parent id (mirrors what the started event already carried).
   * Allows the applier to decide whether to propagate descendant counters
   * without a follow-up `findById` round-trip. `null` for top-level turns.
   */
  parentSessionUsageId: string | null;
}

export interface ToolStartedPayload {
  channelId: string;
  userId: string;
  agentId: string;
  workspaceId: string;
  stepIndex: number;
  /** Index within the LLM step. Always 0 today (sequential); reserved for
   *  future Promise.all parallel tool execution. */
  toolCallIndex: number;
  toolName: string;
  mcaId?: string;
  startedAt: Date;
  /** Buffer.byteLength(JSON.stringify(input), 'utf8'). Optional if calc fails. */
  inputSizeBytes?: number;
}

export interface ToolEndedPayload {
  endedAt: Date;
  durationMs: number;
  durationSource: AgentUsageDurationSource;
  status: Exclude<ToolExecutionStatus, 'running'>;
  /** Sanitized via sanitizeErrorMessage() and truncated to 1k chars. */
  errorMessage?: string;
  outputSizeBytes?: number;
}

/**
 * Event sourcing source-of-truth row.
 *
 * Discriminated union by `type`. Both `agent_usage_sessions` and
 * `tool_executions` are projections rebuilt from this collection.
 */
export type AgentUsageEvent =
  | {
      eventId: string;
      sessionUsageId: string;
      type: 'session.started';
      payload: SessionStartedPayload;
      appliedAt: Date;
      schemaVersion: 1;
    }
  | {
      eventId: string;
      sessionUsageId: string;
      type: 'session.running';
      payload: SessionRunningPayload;
      appliedAt: Date;
      schemaVersion: 1;
    }
  | {
      eventId: string;
      sessionUsageId: string;
      type: 'session.delta';
      payload: SessionDeltaPayload;
      appliedAt: Date;
      schemaVersion: 1;
    }
  | {
      eventId: string;
      sessionUsageId: string;
      type: 'session.ended';
      payload: SessionEndedPayload;
      appliedAt: Date;
      schemaVersion: 1;
    }
  | {
      eventId: string;
      sessionUsageId: string;
      toolExecutionId: string;
      type: 'tool.started';
      payload: ToolStartedPayload;
      appliedAt: Date;
      schemaVersion: 1;
    }
  | {
      eventId: string;
      sessionUsageId: string;
      toolExecutionId: string;
      type: 'tool.ended';
      payload: ToolEndedPayload;
      appliedAt: Date;
      schemaVersion: 1;
    };

/**
 * Idempotency log for the EventApplier.
 *
 * Before applying any event to projections, the applier insertOne's into this
 * collection. If duplicate key (11000), the event was already applied → skip.
 * Robust across process restarts.
 */
export interface AgentUsageEventApplication {
  eventId: string;
  projectedAt: Date;
}

/**
 * Per-turn projection of usage. One document per `prompt()` call.
 *
 * Derived from `agent_usage_events`. Rebuildable via
 * `scripts/rebuild-agent-usage-projections.ts --shadow`.
 */
export interface AgentUsageSession {
  /** Format: usess_<hex16>. Primary key. */
  sessionUsageId: string;

  /** Parent session id when this turn was triggered by delegation
   *  (recursive, unbounded depth). null for top-level turns. */
  parentSessionUsageId: string | null;

  /**
   * Root of the delegation tree (F3a — Latitude OTLP export). Equals
   * `sessionUsageId` for top-level turns; inherited from the parent for
   * delegated children. Denormalized from `session.started` so the OTLP span
   * export derives a stable tree-wide `traceId`. Optional + additive: sessions
   * created before F3a have it undefined (the assembler falls back to
   * `sessionUsageId`).
   */
  rootSessionUsageId?: string;

  triggerKind: AgentUsageTriggerKind;

  // Context (denormalized for query speed)
  userId: string;
  agentId: string;
  workspaceId: string;
  channelId: string;
  coreId?: string;

  // Provider/model
  provider: LLMUsage['provider'];
  modelId: string;
  /** Actual model used by the provider (after auto-routing if applicable). */
  actualModel?: string;
  /**
   * Real upstream provider that served the turn (`fireworks` | `together` | …).
   * Distinct from the logical `provider` (e.g. `teros`). Projected from
   * `session.delta` (TER-615/F0). Drives the per-upstream health rollup (F1/C1).
   */
  actualProvider?: string;
  /**
   * Latency lane the turn ran on (`interactive` | `background`). Teros turns
   * only (TLANE-REQ-9); absent for every other provider.
   * @spec TLANE-REQ-9
   */
  lane?: 'interactive' | 'background';

  // Timing (wall-clock for display; durationMs is the authoritative figure).
  // `startedAt` is null while the session is `queued` and set to the
  // execution-anchored instant when it flips to `running` (TER-650/G1). Billing
  // (rollup union) and the reconciler's execution-orphan cutoff both key off it.
  startedAt: Date | null;
  endedAt: Date | null;
  durationMs: number | null;
  durationSource: AgentUsageDurationSource | null;
  /**
   * True when the turn was killed by the absolute turn deadline
   * (`turn-deadline`, TER-650) so `durationMs` measures "elapsed until the
   * watchdog killed the turn", not real work. Set from `session.ended`
   * (see SessionEndedPayload). Absent/undefined on normal closes. Reporting
   * uses it (or the legacy range [1_795_000–1_805_000] for pre-flag rows) to
   * produce adjusted agent-hours.
   */
  durationCapped?: boolean;
  /**
   * LLM wall-clock latency of the turn (ms, summed across steps) and
   * time-to-first-token of the first step (ms), measured client-side by the
   * adapter (TER-615/F0). Feed the latency/TTFT histograms in the F1 rollup.
   * Distinct from `durationMs` (which includes tool execution + queueing).
   */
  latencyMs?: number;
  ttftMs?: number;

  // Status
  status: AgentUsageSessionStatus;
  errorKind?: AgentUsageErrorKind;
  errorMessage?: string;
  /** Honest-attribution sub-reason (TER-698). Ops-only; see SessionEndedPayload. */
  errorSubReason?: string;
  /** Literal upstream provider message (TER-698, sanitized). Feeds the ops feed. */
  upstreamMessage?: string;
  usagePartial?: boolean;
  /** True if token counts were estimated locally (provider returned no usage). */
  usageEstimated?: boolean;
  /**
   * Provider finish_reason of the turn's last LLM step (`stop` / `length` /
   * `tool_calls` / …). Projected from session.delta (TER-616/R4). `length` is
   * the truncation proxy (§3.1). Absent for turns that errored before any
   * response, or for providers that do not report it.
   */
  stopReason?: string;
  /** True if the turn failed over Fireworks→Together (TER-617/F3, R4). */
  fallbackUsed?: boolean;
  /** When `fallbackUsed`, the errorClass that made the primary fail. */
  primaryErrorClass?: string;

  // Own tokens (this turn only)
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  reasoningTokens: number;
  /** input + output (without cache, to avoid double counting). */
  totalTokens: number;
  costUsd: number;

  // Descendant tokens (delegation: aggregated from child sessions)
  descendantInputTokens: number;
  descendantOutputTokens: number;
  descendantCostUsd: number;
  descendantSessionCount: number;

  // Counts
  llmCallCount: number;
  toolCallCount: number;
  /**
   * Tool executions of the turn that ended in `status: 'error'`. Incremented
   * by the applier on each failing `tool.ended` (idempotent via the event
   * claim). Feeds the per-upstream tool-error-rate in the F1 rollup (R4.3).
   */
  toolErrorCount?: number;

  /**
   * Per-category token breakdown (accumulated via $inc from session.delta
   * payloads). Optional: legacy sessions created before this field landed
   * have it undefined; new sessions always carry it once at least one
   * delta has applied. The breakdown is scaled to match `inputTokens +
   * cachedReadTokens` (factor of correction in ConversationManager) so
   * the categories sum exactly to the real input side.
   */
  tokenBreakdown?: SessionTokenBreakdown;

  // Audit
  schemaVersion: 1;
  createdAt: Date;
  updatedAt: Date;

  /**
   * Marker written ONLY by `scripts/demo-monitoring-seed.mts` (local dev). Real
   * turns never set it. Every dashboard/rollup read excludes `demoSeed: true`
   * via `EXCLUDE_DEMO_SEED` so seed data never blends into real numbers. A1.2.
   */
  demoSeed?: boolean;
}

/**
 * Per-tool projection (append-only). One document per tool invocation.
 *
 * Correlation with tokens: not directly (LLMs don't report per-tool usage).
 * Use `(sessionUsageId, stepIndex+1)` to find the LLM call that processed
 * this tool's output in `llm_usage`.
 */
export interface ToolExecution {
  /** Format: tex_<hex16>. Primary key. */
  toolExecutionId: string;
  /** FK to agent_usage_sessions.sessionUsageId. */
  sessionUsageId: string;
  channelId: string;
  userId: string;
  agentId: string;
  workspaceId: string;
  /** LLM step that requested this tool call. */
  stepIndex: number;
  /** Index within the step. Always 0 today (sequential execution). */
  toolCallIndex: number;
  toolName: string;
  mcaId?: string;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  durationSource: AgentUsageDurationSource | null;
  status: ToolExecutionStatus;
  errorMessage?: string;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  schemaVersion: 1;
  createdAt: Date;
  /** Local-dev seed marker; excluded from every real read. See AgentUsageSession.demoSeed. */
  demoSeed?: boolean;
}

/**
 * MCA tool test status — mirrors the UI union in
 * packages/app/src/windows/McasWindow/mcaStatus.types.ts (D-01, lossless rehydration).
 *
 * The backend cannot import app code, so this is a deliberate copy that MUST be kept
 * in sync with the app union — the whole point of D-01 is that the two are identical
 * so rehydration into the dashboard is lossless. Distinct from `ToolExecutionStatus`
 * (append-only session telemetry — wrong domain, do NOT reuse).
 */
export type ToolTestStatus = 'ok' | 'pending' | 'fail' | 'confirm' | 'skip';

/**
 * Per-tool health snapshot for an MCA (Phase 5, TEST-06).
 *
 * One row per (mcaId, tool) — the collection's unique key; re-recording a tool
 * overwrites rather than appends (upsert semantics). Stores ONLY the last test
 * outcome; there is intentionally NO `overall`, `appId`, `inputs`, or `outputs`
 * field: the UI derives `overall` itself (D-04), and raw inputs/outputs are never
 * persisted because they carry PII/secret leak risk (D-07 / SC3). Distinct from
 * `ToolExecution` (append-only session telemetry); this is upsert-overwrite fleet
 * health.
 */
export interface McaToolHealth {
  /** Joins to mca_catalog.mcaId. Part of the unique key. */
  mcaId: string;
  /** Tool name; joins to catalog tools[]. Part of the unique key. */
  tool: string;
  /** Reuses the UI's 5-state union (D-01). Do NOT reuse ToolExecutionStatus. */
  status: ToolTestStatus;
  /** Server-generated at record time (D-05). Serialized to ISO on read. */
  testedAt: Date;
  /** Short error/notes, server-truncated to ~500 chars (D-06). Seed `notes` maps here. */
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Additive latency distribution (bucketed sketch) persisted in the F1 rollup.
 * The bucket layout is fixed (OTel GenAI duration boundaries expressed in ms —
 * see `services/latency-histogram.ts`); `buckets` length is bounds.length + 1
 * (the last slot is the overflow bucket). Additivity is the whole point: the WS
 * query merges hourly histograms into a range view and derives the (NON-additive)
 * percentiles at read time. TER-616/F1.
 */
export interface LatencyHistogram {
  buckets: number[];
  count: number;
  sum: number;
  /**
   * Largest sample observed (ms), or 0 for an empty histogram. Additive under
   * merge via `Math.max` — lets a percentile that falls in the unbounded
   * overflow bucket `(81920ms, +inf)` be reported as "≥81.9s" (capped) instead
   * of silently clamping to the lower edge, and gives the UI the real tail
   * magnitude for reasoning models >82s. Optional: legacy rollups predate it
   * (treated as 0 / "unknown tail"). TER-674/A3.1.
   */
  max?: number;
}

/**
 * Per-`actualProvider×modelId` health entry embedded in
 * `AgentUsageRollupHourly.modelHealth`. Every counter is additive across hourly
 * rollups, so a 24h/7d view is a plain merge. TER-616/F1.
 */
export interface ModelHealthEntry {
  /** Real upstream provider that served the turns (`fireworks` | `together` | …). */
  actualProvider: string;
  /** Logical model id. */
  modelId: string;
  /** Turns observed for this upstream×model in the bucket (throughput). */
  requestCount: number;
  /** End-to-end latency distribution (ms per turn). */
  latency: LatencyHistogram;
  /** Time-to-first-token distribution (ms, first step of the turn). */
  ttft: LatencyHistogram;
  /** Turns per terminal status — drives success-rate. */
  statusCounts: Partial<Record<AgentUsageSessionStatus, number>>;
  /** Errored turns per errorKind — the degradation breakdown (rate_limited / overloaded / …). */
  errorCounts: Partial<Record<AgentUsageErrorKind, number>>;
  /**
   * Errored turns per honest-attribution sub-reason (TER-698/TER-700):
   * `provider_capacity` / `account_rate_limit` / `provider_billing` /
   * `model_unavailable` / … — refines `errorCounts` so the ops feed can split a
   * capacity storm from a billing wall. Additive; legacy rollups predate it.
   */
  subReasonCounts?: Partial<Record<string, number>>;
  /**
   * Turns per provider finish_reason (`stop` / `length` / `tool_calls` / …).
   * `length` is the truncation proxy (§3.1, TER-616/R4). Additive. Optional:
   * legacy rollups predate it.
   */
  finishReasons?: Partial<Record<string, number>>;
  /** Completed turns that produced zero output tokens — the empty-response proxy (§3.1, R4.5). */
  emptyCount?: number;
  /**
   * Turns with RELIABLE usage (`!usagePartial`) — the denominator for
   * `emptyRate`. The `emptyCount` numerator already excludes `usagePartial`
   * turns; denominating over `requestCount` (which includes them) biases the
   * rate toward green when most turns have partial usage (74% in the alpha
   * snapshot → a real 8% empty-rate rendered ~2%). Additive. Optional: legacy
   * rollups predate it — the aggregator falls back to `requestCount`. TER-674/A3.3.
   */
  measuredCount?: number;
  /**
   * Turns that reported a provider `finish_reason` — the denominator for
   * `truncationRate` (only turns whose finish_reason is known can be judged
   * truncated). Additive. Optional: legacy rollups predate it — the aggregator
   * falls back to `requestCount`. TER-674/A3.3.
   */
  stopReasonCount?: number;
  /** Turns that failed over Fireworks→Together (TER-617/F3, R3.4). Drives fallbackRate. */
  fallbackCount?: number;
  /** Total tool executions across the bucket's turns — denominator for toolErrorRate (R4.3). */
  toolCallCount?: number;
  /** Tool executions that ended in `error` — numerator for toolErrorRate (R4.3). */
  toolErrorCount?: number;
}

/**
 * Hourly rollup by (user, agent, provider, workspace).
 *
 * `modelId` is intentionally NOT in the groupKey to keep cardinality
 * manageable (~315 GB at TTL 730d for 1k users). Per-model breakdown is
 * embedded in `modelMix`.
 *
 * Sessions crossing midnight are split proportionally across buckets
 * (decision #18).
 */
export interface AgentUsageRollupHourly {
  /** Format: usro_<hex16>. Primary key. */
  rollupId: string;
  /** Truncated to hour UTC. */
  hourBucket: Date;
  groupKey: {
    userId: string;
    agentId: string;
    provider: LLMUsage['provider'];
    workspaceId: string;
  };
  /** Per-model breakdown for drill-down (sums to the totals below). */
  modelMix: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cachedReadTokens: number;
      totalTokens: number;
      costUsd: number;
      sessionCount: number;
    }
  >;
  /**
   * Per-`actualProvider×modelId` health distribution for the model-observability
   * window (TER-616/F1). ADDITIVE and orthogonal to `modelMix`: keyed by
   * `${actualProvider}::${modelId}` so the real upstream (Fireworks vs Together)
   * is distinguishable even when the logical `provider` is the same (`teros`).
   * The histograms are additive → the WS query merges these across the hours of
   * the requested range and derives p50/p95/p99 (percentiles are NOT additive,
   * the histograms are). Optional: legacy rollups predate this field.
   */
  modelHealth?: Record<string, ModelHealthEntry>;
  // Totals (sum of modelMix)
  sessionCount: number;
  completedCount: number;
  erroredCount: number;
  timedOutCount: number;
  abortedCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  /** SUM(durationMs) split proportionally if the session crosses midnight. */
  agentActiveMs: number;
  computedAt: Date;
  jobRunId: string;
  schemaVersion: 1;
  createdAt: Date;
  /** Local-dev seed marker; excluded from every real read. See AgentUsageSession.demoSeed. */
  demoSeed?: boolean;
}

/**
 * Per-hour completion marker for the rollup job (A1.2).
 *
 * One document per fully-rolled closed hour, written ONLY after both persist
 * phases of `processHour` succeed with at least one rollup doc. The job gates on
 * the presence of this marker instead of `agent_usage_rollups_hourly.findOne(
 * {hourBucket})`, which fixes two failure modes of the old exists-check:
 *   - demo-seed rollups for an hour made the job skip that hour forever, losing
 *     the real sessions that landed in it;
 *   - a crash between the agent-rollup and user-rollup writes left a partial doc
 *     that likewise bricked the hour.
 * The marker is never written by the seed, and only after both writes complete,
 * so a partially-rolled or demo-only hour is reprocessed (upserts are idempotent)
 * until it genuinely completes.
 */
export interface AgentUsageRollupRun {
  /** Truncated to hour UTC. Unique. */
  hourBucket: Date;
  /** When the hour finished rolling successfully. */
  completedAt: Date;
  /** The `jobRunId` of the run that completed the hour. */
  jobRunId: string;
  agentDocsWritten: number;
  userDocsWritten: number;
  /** 2 = user_hourly docs of this hour carry userWorkMs (decision #29). */
  schemaVersion: 1 | 2;
}

/**
 * Hourly rollup by user only.
 *
 * Required because `userActiveSeconds` (union of intervals across all the
 * user's agents) cannot be reconstructed by summing per-agent rollups
 * (intervals may overlap). Computed by the rollup job with a JS merge of
 * intervals (decision #26).
 */
export interface AgentUsageRollupUserHourly {
  /** Format: usro_<hex16>. Primary key. */
  rollupId: string;
  hourBucket: Date;
  groupKey: {
    userId: string;
    workspaceId: string;
  };
  /** Union of session intervals truncated to the hour. <= 3_600_000. Analytical metric (decision #26). */
  userActiveMs: number;
  /**
   * Sum of the per-session overlap (billable work) inside the hour — NOT
   * coalesced: 2 agents working the same 10 min in parallel = 20 min of work.
   * This is the QUOTA metric (decision #29): the agent-hour is Teros's unit of
   * business, so parallelism burns quota faster. Present from schemaVersion 2;
   * readers fall back to `userActiveMs` on v1 buckets.
   */
  userWorkMs?: number;
  sessionCount: number;
  totalTokens: number;
  costUsd: number;
  computedAt: Date;
  jobRunId: string;
  /** 2 = userWorkMs present (decision #29). 1 = pre-#29 buckets (no userWorkMs). */
  schemaVersion: 1 | 2;
  createdAt: Date;
}

/**
 * Append-only audit trail of admin access to a session's full trace (TER-671 /
 * A6.3). One document per `admin-api.agent-usage-session-detail` call — the trace
 * exposes cross-tenant conversation structure (and, for supers, plaintext), so
 * every read is recorded before the data is returned (ledger-first). Never
 * updated or deleted by the app; TTL-bounded.
 */
export interface AgentUsageAccessLog {
  /** The admin/super who read the trace. */
  adminUserId: string;
  /** Their system role at access time. */
  role: 'admin' | 'super';
  /** The session whose trace was read. */
  sessionUsageId: string;
  /** Whether the plaintext was included (super) or redacted (admin). */
  textIncluded: boolean;
  at: Date;
  schemaVersion: 1;
}

// ============================================================================
// MESSAGE FEEDBACK COLLECTION
// ============================================================================

/**
 * Thumbs up/down rating attached to a specific assistant message.
 * One document per (userId, messageId) pair.
 */
export interface MessageFeedback {
  /** Format: fb_<uuid>. Primary key. */
  feedbackId: string;
  messageId: string;
  conversationId: string;
  workspaceId: string;
  userId: string;
  agentId: string;
  rating: 'up' | 'down';
  reasons?: string[];
  comment?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// MESSAGE ACTIONS COLLECTION
// ============================================================================

/**
 * Logged action on a message (copy or report).
 */
export interface MessageAction {
  /** Format: act_<uuid>. Primary key. */
  actionId: string;
  messageId: string;
  conversationId: string;
  workspaceId: string;
  userId: string;
  action: 'copy' | 'report';
  context?: Record<string, unknown>;
  createdAt: Date;
}

// ============================================================================
// CONVERSATION FEEDBACK COLLECTION
// ============================================================================

/**
 * End-of-conversation quality signal.
 */
export interface ConversationFeedback {
  /** Format: cfb_<uuid>. Primary key. */
  conversationFeedbackId: string;
  conversationId: string;
  workspaceId: string;
  userId: string;
  rating: number | 'up' | 'down';
  solvedProblem?: boolean;
  comment?: string;
  createdAt: Date;
}

// ============================================================================
// BILLING COLLECTIONS
// ============================================================================

/**
 * Billing Plan — Base plan template (seeded, rarely changes).
 *
 * Defines the tiers available in Teros Cloud: Basic, Pro, Max, Infinity.
 * Used for feature-gating and pricing reference.
 */
export interface BillingPlan {
  /** Primary key — human-readable, e.g. "plan_starter" */
  _id: string;

  name: string;
  displayName: string;
  description: string;

  // Pricing
  price: number;
  currency: string;

  // Consumption
  agentHoursLimit: number;

  // Features (feature-gating)
  features: {
    byok: boolean;
    sectureModel: boolean;
    unlimitedAgents: boolean;
    maxWorkspaces: number;
    prioritySupport: boolean;
  };

  // Visibility
  isPublic: boolean;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Billing Subscription — One per user. Overrides plan values when needed.
 *
 * Tracks the user's current tier, custom limits/prices (for discounts),
 * agent-hours consumed this cycle, and manual billing status.
 */
export interface BillingSubscription {
  /** MongoDB ObjectId */
  _id: string;

  userId: string;
  planId: string;

  // Individual overrides (what Pablo requested)
  customAgentHoursLimit: number | null;
  customPrice: number | null;
  customPriceNote: string | null;

  // Consumption (current cycle)
  agentHoursUsed: number;
  overageHours: number;

  /**
   * Greatest hourBucket already billed into agentHoursUsed by the
   * agent-hours-tracker. Idempotency cursor — absent means "never billed".
   */
  lastBilledHourBucket?: Date;

  // Billing cycle
  currentPeriodStart: Date;
  currentPeriodEnd: Date;

  // Status
  status: 'active' | 'paused' | 'cancelled' | 'past_due';

  // Manual billing (Phase 1)
  billingStatus: 'pending' | 'invoiced' | 'paid' | 'waived';
  billingNotes: string;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}
