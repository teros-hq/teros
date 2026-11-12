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
  // Voice Mode v2 (spec v1.1.0 §Fase 1): engine selector. `elevenlabs` keeps the
  // legacy ConvAI proxy (voice-handler.ts); `native` switches to the new
  // voice-loop.ts (STT + Teros turn + TTS + barge-in). The UI (F3a) works over
  // both — it translates legacy frames to the 3 axes at the boundary.
  'voice.engine': {
    key: 'voice.engine',
    type: 'string',
    defaultValue: 'elevenlabs',
    enumValues: ['elevenlabs', 'native'],
    description:
      "Voice engine: 'elevenlabs' = legacy ConvAI proxy (current), 'native' = new voice loop (STT + Teros turn + TTS, Fase 1). Frontend works over both — legacy frames are translated to the v2 axes (presencia × modo × actividad) at the boundary.",
    category: 'voice',
  },
  // Voice Mode v2 (F3a — UX): gates the new presence UI (PresenceOrb,
  // ModePicker, PresenceDot, bloom/collapse). Off = the legacy swap
  // (InputComposer ↔ VoiceControls) keeps working untouched — zero regression.
  'voice.mode-ui': {
    key: 'voice.mode-ui',
    type: 'boolean',
    defaultValue: false,
    description:
      'Voice Mode v2 presence UI: PresenceOrb (the agent body), ModePicker (3 modes), PresenceDot in the navbar, and bloom/collapse replacing the composer swap. Off = legacy voice UI, zero regression. Requires voice.enabled to be meaningful.',
    category: 'voice',
  },
  // Voice Mode v2 (F3b — hilo unificado): dev-only mock for REQ-9 overheard.
  // The legacy engine never flags heard-but-not-addressed speech; the native
  // loop (F2b) will. Until then, this flag marks user speech in
  // passive as overheard so the tenue rows render and the contract
  // is exercised. REMOVE when F2b lands.
  'voice.overheard-mock': {
    key: 'voice.overheard-mock',
    type: 'boolean',
    defaultValue: false,
    description:
      'DEV ONLY (remove when F2b lands): mark user speech in passive mode as overheard so the tenue OverheardRow renders against the legacy engine. The native loop (F2b) will send the real overheard flag.',
    category: 'voice',
  },
  // Voice Mode v2 (F5a — fast LLM leg): which model thinks a voice turn.
  // `agent` (default) = the agent's own model with the full channel context
  // (current behavior, zero change). `fast` = a configurable fast model with
  // a trimmed voice context (short system prompt + last ~12 history lines +
  // compaction summary) — what the whole market does for spoken turns (see
  // docs/specs/voice-mode/2026-10-realtime-latency-research.md §4 Fase A).
  // The agent's tools/permissions/persistence stay identical — only the
  // model and the context for THIS turn change. If the fast model fails
  // (timeout/error before first output), the turn falls back to the agent
  // model automatically.
  'voice.llm': {
    key: 'voice.llm',
    type: 'string',
    defaultValue: 'agent',
    enumValues: ['agent', 'fast'],
    description:
      "LLM leg for voice turns: 'agent' (default) = the agent's own model + full context (current behavior); 'fast' = a fast model (voice.llm-fast-model) with a trimmed voice context, with automatic fallback to the agent model on error. Only affects turns that originate in voice (native engine).",
    category: 'voice',
  },
  // F5a secondary flag: WHICH fast model runs the voice turn (a Teros
  // provider modelId). Default teros-deepseek-v4p1-flash; benchmarked
  // candidates: teros-deepseek-v4p1-flash, teros-glm-5p3-flash,
  // teros-kimi-k3-fast. Unknown modelIds degrade to 'agent' behavior (log).
  'voice.llm-fast-model': {
    key: 'voice.llm-fast-model',
    type: 'string',
    defaultValue: 'teros-s',
    description:
      'Fast model (Teros SIZE id) for voice turns when voice.llm=fast: teros-s (default), teros-m or teros-l. The size router maps it to the configured upstream model (TPROV-REQ-8). An unknown/inactive id degrades to the agent model.',
    category: 'voice',
  },
  // F5a: reasoning_effort sent upstream with the fast model. deepseek and
  // kimi accept 'none' (fastest — no reasoning tokens); glm-5p3-flash is
  // thinking-only and REQUIRES 'low' (it rejects 'none'). Default 'none'
  // matches the default model (deepseek). Switch to 'low' if you point
  // voice.llm-fast-model at a GLM flash model.
  'voice.llm-fast-effort': {
    key: 'voice.llm-fast-effort',
    type: 'string',
    defaultValue: 'none',
    enumValues: ['none', 'low', 'medium', 'high'],
    description:
      "reasoning_effort for the fast voice model. 'none' (default, fastest — deepseek/kimi accept it); 'low' required for thinking-only models (glm-5p3-flash rejects 'none').",
    category: 'voice',
  },
  // Voice Mode v2 (F5d — TTS stream-input): which TTS synthesis strategy the
  // native voice loop uses. `sentences` (default) = the current provider —
  // buffer text, synthesize per completed sentence (one HTTP request each).
  // `stream` = the ElevenLabs stream-input WebSocket: deltas are pushed
  // word-by-word and the server starts generating at the first
  // chunk_length_schedule threshold (~50 chars) — first audio at half a
  // sentence, like Vapi/Retell. Automatic fallback to `sentences` if the WS
  // fails. The ITtsProvider contract, the loop and the frontend player do
  // not change — only the synthesis strategy.
  'voice.tts': {
    key: 'voice.tts',
    type: 'string',
    defaultValue: 'sentences',
    enumValues: ['sentences', 'stream'],
    description:
      "TTS strategy for the native voice loop: 'sentences' (default) = synthesize per completed sentence (HTTP, current behavior); 'stream' = ElevenLabs stream-input WebSocket — deltas word-by-word, first audio at ~50 chars (chunk_length_schedule), with automatic fallback to 'sentences' if the WS fails. Only affects the native engine.",
    category: 'voice',
  },
  // Voice Mode v2 (F5b — perception tuning): endpointing ms of silence that
  // close a user utterance (Deepgram `endpointing` param). The pre-F5b loop
  // hardcoded 300ms — Spanish mid-sentence pauses ("¿vale?", "es decir")
  // exceed that and split phrases into separate turns (Pablo's live evidence
  // 2026-10-03). Default 200ms: Deepgram's own realtime guidance is 10–200ms
  // for conversational use; 200 is the aggressive-but-supported end. If live
  // telemetry shows premature turn closes in Spanish, raise to 250 here (the
  // flag is the knob — no code change needed). The provider-level tunable
  // (DeepgramStreamingTranscriptionProvider config endpointingMs) still wins
  // over this flag when set explicitly — config > flag > 300 provider default.
  'voice.endpointing-ms': {
    key: 'voice.endpointing-ms',
    type: 'number',
    defaultValue: 200,
    description:
      'Endpointing (ms of silence) that closes a user utterance in the native voice loop (Deepgram). Lower = snappier turn-taking, higher = safer against mid-sentence pauses. Default 200ms (was 300ms hardcoded pre-F5b). Raise to 250 if Spanish speech gets split mid-phrase.',
    category: 'voice',
  },
  // Voice Mode v2 (F5b — perception tuning): the optional filler phrase. When
  // a user turn activates and the first LLM text chunk has NOT arrived within
  // ~400ms, the loop plays a pre-generated "Mmm." MP3 (the agent's default
  // voice, baked once — NEVER a new ElevenLabs call at runtime) at low volume
  // to cover the dead silence. Interruptible by barge-in like any TTS. If the
  // first chunk arrives within the window, nothing plays — the filler only
  // covers the REAL gap. Default off: it is a perception patch, not a fix.
  'voice.filler': {
    key: 'voice.filler',
    type: 'boolean',
    defaultValue: false,
    description:
      'Play a pre-generated short filler ("Mmm.", the agent default voice, baked MP3) when the first LLM chunk of a voice turn takes longer than ~400ms. Default off. Interruptible by barge-in; never synthesized at runtime.',
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
  // Non-blocking user interactions (docs/specs/20261024_non-blocking-user-interactions.md).
  // MIGRATION SCAFFOLDING: gates the new non-blocking path (forms return an
  // immediate marker, permissions return permission_requested, answers arrive
  // as channel messages + wake). After E2E validation on RAW the v1 blocking
  // awaits are deleted and this flag is removed — end state is ONE path.
  'tools.execution-proxy': {
    key: 'tools.execution-proxy',
    type: 'boolean',
    defaultValue: false,
    description:
      "Tool-execution proxy: the agent gets only the list-installed-apps / list-app-tools / execute-tool meta-tools and discovers/runs every app's tools on demand instead of having them preloaded into the LLM context. Apps pinned App.toolExposure='direct' opt out (their tools stay individually listed). Off = no meta-tools, every app exposed directly.",
    category: 'tools',
  },
  'tools.flat-toolcalls': {
    key: 'tools.flat-toolcalls',
    type: 'boolean',
    defaultValue: false,
    description:
      'Flat tool-call format: proxy apps expose their tools as flat virtual tools (e.g. remote_napoli_bash) with schemas that do not require nested JSON. Avoids corruption from LLMs that struggle with JSON-in-JSON escaping. Requires tools.execution-proxy ON. Off = only meta-tools (list-installed-apps, list-app-tools, execute-tool) are injected.',
    category: 'tools',
  },
  // 🛡️ Teros Guard (docs/specs/security/20261106_teros-guard.md). GLOBAL rollout
  // switch for the LLM review layer over `allow` calls: OFF = the guard never
  // runs, regardless of workspace settings. The per-workspace switch lives in
  // settings.terosGuard.enabled — both must be ON. Fase 1 ships with this flag
  // OFF (core only, zero behavior change).
  'tools.teros-guard': {
    key: 'tools.teros-guard',
    type: 'boolean',
    defaultValue: false,
    description:
      'Teros Guard: LLM review of ALLOWED tool calls on watched apps (bash, filesystem, email, payments) against the user request — pass / force_ask / block. Global rollout switch; a workspace must also enable settings.terosGuard. Off = guard never runs (zero change).',
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
  // `teros.fallback` retired (TPROV-NFR-2): failover lives in the Teros provider config (admin window).
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
  'flows.enabled': {
    key: 'flows.enabled',
    type: 'boolean',
    defaultValue: false,
    description:
      'Enable the Flows/Workflows UI — visual flow builder, flow list, and execution monitor. When disabled, all flow windows are hidden and cannot be opened.',
    category: 'flows',
  },
  // Academy (TER-716): the shipped catalog is placeholder content (all videos
  // use the dummy YouTube id 'dQw4w9WgXcQ'). Off by default until the real
  // video content lands; flip the DB default to true when it does.
  'academy.enabled': {
    key: 'academy.enabled',
    type: 'boolean',
    defaultValue: false,
    description:
      "Enable the Academy window (videotutorial catalog) and its Navbar entry. When disabled, the window is hidden and cannot be opened. Currently off because the catalog ships placeholder videos pending real content.",
    category: 'academy',
  },

  // What's New (WNEW-REQ-1): off for everyone. A new user has seen no entry,
  // so the modal opened with the whole changelog right after onboarding.
  'whats-new.enabled': {
    key: 'whats-new.enabled',
    type: 'boolean',
    defaultValue: false,
    description:
      "Show the What's New changelog modal (auto-open on unseen entries) and its navbar entry. Off: neither appears.",
    category: 'whats-new',
  },

  'automate_v1': {
    key: 'automate_v1',
    type: 'boolean',
    defaultValue: false,
    description:
      'Enable the Automate window (sidebar + launcher): starters that couple a trigger (scheduler, webhook, event) with an action (create task, channel event, start flow).',
    category: 'automate',
  },
  // Post-processing of STT transcripts (voice notes): removes fillers, false
  // starts, stutters and non-speech markers BEFORE the text reaches the agent
  // (Pablo 2026-10-31: "mmm, [chasquido], eh, o sea, si digo, digo: imagínate
  // que digo algo" must arrive as "Si digo algo"). The cleaner runs in
  // message-handler._transcribeAudioFile, between the STT provider and the
  // agent/user delivery. Meaning is never altered — heuristic layer is
  // whitelist-based; the LLM layer (teros-glm-5p3-flash, credential-free) is
  // guarded by a no-invented-content similarity check and falls back to the
  // heuristic result on any error/timeout. Literal-dictation audios can opt
  // out per message via the stt.clean-literal flag (or per user/workspace
  // override when a user mostly dictates exact text).
  'stt.clean': {
    key: 'stt.clean',
    type: 'boolean',
    defaultValue: false,
    description:
      "Clean STT transcripts before delivery: remove fillers, false starts, stutters and non-speech markers. Off = raw transcript (current behavior). Applies to voice notes in chat; never alters meaning.",
    category: 'voice',
  },
  'stt.clean-mode': {
    key: 'stt.clean-mode',
    type: 'string',
    defaultValue: 'llm',
    enumValues: ['heuristic', 'llm'],
    description:
      "Cleaning strategy when stt.clean is on: 'heuristic' = deterministic whitelist regex only (zero latency, misses false starts like 'si digo, digo: imagínate que digo algo'); 'llm' = heuristic pass + one cheap internal-LLM rewrite (teros-glm-5p3-flash) with no-invented-content guard and 6s timeout, falling back to the heuristic result on any failure.",
    category: 'voice',
  },
  'stt.clean-literal': {
    key: 'stt.clean-literal',
    type: 'boolean',
    defaultValue: false,
    description:
      "Opt-out for literal dictations: when true, transcripts are delivered raw (no cleaning). Useful for users/audios where exact wording matters. Resolution order: per-message request flag > this flag's user/workspace override > stt.clean.",
    category: 'voice',
  },

  // Navbar v2 (rail with 3 zones, pinnable windows). Off = the current Navbar
  // renders exactly as today — zero regression. On = NavbarV2 at the shell.
  'navbar_v2': {
    key: 'navbar_v2',
    type: 'boolean',
    defaultValue: false,
    description:
      'Navbar v2: left rail 64↔272px with 3 zones (fixed / workspace / personal), pinnable windows and drag-to-pin. Off = the current navbar, unchanged.',
    category: 'navbar',
  },

  // Environment context in the system prompt (Fase 1 — activate the dormant
  // SystemPromptBuilder/tree-generator scaffolding inside the live path).
  // Off = prompts byte-identical to today. On = model-service.buildSystemPrompt()
  // appends an <environment> block (workspace cwd, platform, git state and a
  // capped project file tree) to the stable prefix. Fase 2 (app context
  // prehooks, manifest `contextPrehook`) reuses the same slot.
  'prompt.environment-context': {
    key: 'prompt.environment-context',
    type: 'boolean',
    defaultValue: false,
    description:
      'Inject an <environment> block (cwd, platform, git state, capped project tree) into the system prompt, activating the dormant SystemPromptBuilder/tree-generator code. Off = prompts unchanged.',
    category: 'prompt',
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
