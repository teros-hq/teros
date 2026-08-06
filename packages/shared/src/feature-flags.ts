/**
 * Feature Flags Registry
 *
 * Single source of truth for all feature flags in the Teros platform.
 * Defines the schema, types, and default values for every flag.
 *
 * The registry is consumed by:
 * - backend: FeatureFlagService (resolution, overrides, sync)
 * - frontend: Feature flag UI (admin panel, flag viewer)
 *
 * Hierarchical resolution (most specific wins):
 *   user → workspace → company → global (registry default)
 */

// ============================================================================
// TYPES
// ============================================================================

/** Supported feature flag value types */
export type FeatureFlagType = 'boolean' | 'number' | 'string' | 'string[]';

/** Runtime value for a feature flag */
export type FeatureFlagValue = boolean | number | string | string[];

/** Target types for overrides (ordered by specificity, most specific first) */
export type FeatureFlagTargetType = 'user' | 'workspace' | 'company';

/** Target specificity ranking — higher = more specific */
export const TARGET_SPECIFICITY: Record<FeatureFlagTargetType, number> = {
  user: 3,
  workspace: 2,
  company: 1,
};

/** Override target order for resolution (most specific first) */
export const TARGET_RESOLUTION_ORDER: FeatureFlagTargetType[] = ['user', 'workspace', 'company'];

// ============================================================================
// DEFINITION
// ============================================================================

/**
 * Static definition of a feature flag from the code registry.
 * This is the source of truth for type, default value, and metadata.
 */
export interface FeatureFlagDefinition {
  /** Dot-notation key (e.g., 'voice.enabled') */
  key: string;

  /** Value type — used for validation */
  type: FeatureFlagType;

  /** Default value when no override exists */
  defaultValue: FeatureFlagValue;

  /** Human-readable description */
  description: string;

  /** Category for grouping in UI */
  category: string;

  /**
   * Allowed values for a `string` flag whose values are a closed set
   * (e.g. `teros.fallback` = off | on-error | cutover). When present, the admin
   * UI renders a segmented selector instead of a free-text input. Optional —
   * a `string` flag without this stays free-text.
   */
  enumValues?: string[];
}

// ============================================================================
// REGISTRY
// ============================================================================

/**
 * All feature flags defined in the platform.
 *
 * To add a new flag:
 * 1. Add an entry here
 * 2. It will be auto-synced to MongoDB at startup
 * 3. Overrides can be created via FeatureFlagService.setOverride()
 */
export const FEATURE_FLAG_REGISTRY: Record<string, FeatureFlagDefinition> = {
  'access.auto-grant': {
    key: 'access.auto-grant',
    type: 'boolean',
    defaultValue: false,
    description:
      'Automatically grant platform access to new users on sign-up. When enabled, users skip the private beta waitlist and go straight to the welcome/terms screen.',
    category: 'access',
  },
  'voice.enabled': {
    key: 'voice.enabled',
    type: 'boolean',
    defaultValue: false,
    description: 'Enable voice input and output features',
    category: 'voice',
  },
  'files.max-size-mb': {
    key: 'files.max-size-mb',
    type: 'number',
    defaultValue: 50,
    description: 'Maximum file upload size in megabytes',
    category: 'files',
  },
  'onboarding.flow': {
    key: 'onboarding.flow',
    type: 'string',
    defaultValue: 'default',
    description: 'Onboarding flow variant (default, minimal, guided)',
    category: 'onboarding',
  },
  'tools.parallel-execution': {
    key: 'tools.parallel-execution',
    type: 'boolean',
    defaultValue: false,
    description:
      "Dispatch tool calls within a turn concurrently (`Promise.all`). Default `false` runs them one-by-one (sequential); turning it on also revives the grouped-permission panel from TER-375.",
    category: 'tools',
  },
  'tools.user-forms': {
    key: 'tools.user-forms',
    type: 'boolean',
    defaultValue: false,
    description:
      'Inline user forms: injects the built-in request-user-input tool so the agent can send the user a structured form to fill inline in the chat; the turn blocks (like a permission) until the user submits or dismisses. On headless/voice channels the tool returns a bypass result instructing the agent to ask conversationally. Off = tool not injected, feature invisible.',
    category: 'tools',
  },
  'tools.execution-proxy': {
    key: 'tools.execution-proxy',
    type: 'boolean',
    defaultValue: false,
    description:
      "Tool-execution proxy: the agent gets only the list-installed-apps / list-app-tools / execute-tool meta-tools and discovers/runs every app's tools on demand instead of having them preloaded into the LLM context. Apps pinned App.toolExposure='direct' opt out (their tools stay individually listed). Off = no meta-tools, every app exposed directly.",
    category: 'tools',
  },
  // Latitude OTLP export (F3a/F3b). `observability.latitude-export` is the
  // runtime toggle for shipping agent-turn traces to the self-hosted Latitude;
  // the LATITUDE_EXPORT_* config is the capability. `-content` gates message
  // text (F3b) and is inert until that lands.
  'observability.latitude-export': {
    key: 'observability.latitude-export',
    type: 'boolean',
    defaultValue: false,
    description:
      'Export agent-turn traces (structure only — no message text) to the self-hosted Latitude via OTLP. Off = nothing leaves Teros. Needs the LATITUDE_EXPORT_* config present; this flag is the runtime on/off (F3a).',
    category: 'observability',
  },
  'observability.latitude-export-content': {
    key: 'observability.latitude-export-content',
    type: 'boolean',
    defaultValue: false,
    description:
      'Include message text in the Latitude export (F3b, gated). Requires observability.latitude-export ON plus a per-call ZDR guard and legal sign-off. Off = structure-only. Not honored until F3b lands.',
    category: 'observability',
  },
  'observability.latitude-scores': {
    key: 'observability.latitude-scores',
    type: 'boolean',
    defaultValue: false,
    description:
      'Emit categorical failure scores (thumbs_down / tool_error — never message text) to the self-hosted Latitude scores API so it can cluster signals. Off = no scores leave Teros. Gated per-turn by the ZDR retention guard; needs LATITUDE_API_URL + LATITUDE_EXPORT_TOKEN/PROJECT (F4·C0).',
    category: 'observability',
  },
  // Failover policy for the `teros` provider (TER-617/F3). Manual gate — the team
  // arms/disarms this watching the F1 model-health signal; NOT a circuit-breaker.
  'teros.fallback': {
    key: 'teros.fallback',
    type: 'string',
    defaultValue: 'off',
    enumValues: ['off', 'on-error', 'cutover'],
    description:
      "Failover policy for the `teros` provider. `off` = Fireworks-only (current); `on-error` = Fireworks primary + one retry on Together for transient errors (429/503/5xx/timeout/connection); `cutover` = straight to Together (hard Fireworks outage). Together is only used when its ZDR is asserted (resolveRetention guard) — otherwise the fallback stays inert.",
    category: 'provider-fallback',
  },
  // Agent-core rollout flags. Each coreType maps to a flag whose value is the
  // coreId an agent of that scope should run. `defaultValue` is the STABLE
  // (canonical) coreId; a `rollout` on the flag points at an experimental coreId
  // for a percentage of users (resolved by ownerId bucketing). Consumed by the
  // admin "apply rollout" action, which re-points + reprovisions agents — the
  // runtime turn path never reads these. See feature-flag-rollout.ts (TER-412).
  'core.agent': {
    key: 'core.agent',
    type: 'string',
    defaultValue: 'agent',
    description:
      'coreId assigned to workspace-scoped agents. Default is the stable `agent` core; a rollout points at an experimental core for a % of owners.',
    category: 'agent-cores',
  },
  'core.super-agent': {
    key: 'core.super-agent',
    type: 'string',
    defaultValue: 'super-agent',
    description:
      'coreId assigned to global/personal agents. Default is the stable `super-agent` core; a rollout points at an experimental core for a % of owners.',
    category: 'agent-cores',
  },
};

/** Ordered list of all flag keys */
export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAG_REGISTRY);

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate that a value matches the expected type for a flag.
 * Throws TypeError if the value is invalid.
 */
export function validateFeatureFlagValue(
  key: string,
  value: unknown,
): FeatureFlagValue {
  const def = FEATURE_FLAG_REGISTRY[key];
  if (!def) {
    throw new TypeError(`Unknown feature flag: ${key}`);
  }

  switch (def.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new TypeError(
          `Feature flag "${key}" expects boolean, got ${typeof value}`,
        );
      }
      return value;

    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new TypeError(
          `Feature flag "${key}" expects number, got ${typeof value}`,
        );
      }
      return value;

    case 'string':
      if (typeof value !== 'string') {
        throw new TypeError(
          `Feature flag "${key}" expects string, got ${typeof value}`,
        );
      }
      return value;

    case 'string[]':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        throw new TypeError(
          `Feature flag "${key}" expects string[], got ${typeof value}`,
        );
      }
      return value as string[];

    default:
      throw new TypeError(`Unknown feature flag type: ${def.type}`);
  }
}

/**
 * Check if a value is valid for a given flag key (non-throwing).
 */
export function isValidFeatureFlagValue(key: string, value: unknown): boolean {
  try {
    validateFeatureFlagValue(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the definition for a flag key, or null if not found.
 */
export function getFeatureFlagDefinition(key: string): FeatureFlagDefinition | null {
  return FEATURE_FLAG_REGISTRY[key] ?? null;
}

/**
 * Get the registry default value for a flag key.
 */
export function getRegistryDefault(key: string): FeatureFlagValue {
  const def = FEATURE_FLAG_REGISTRY[key];
  if (!def) {
    throw new TypeError(`Unknown feature flag: ${key}`);
  }
  return def.defaultValue;
}
