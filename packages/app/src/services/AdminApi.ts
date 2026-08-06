/**
 * AdminApi — Typed client for the admin domain
 *
 * Covers user management (admin/super only).
 * Uses the WsFramework request/response protocol via WsTransport.
 */

import type { Transport } from './transport/types'

// ============================================================================
// Shared types
// ============================================================================

export type UserRole = 'user' | 'admin' | 'super'
export type UserStatus = 'active' | 'suspended' | 'pending_verification'

/**
 * Cuota (usage) filter for the users list — maps to the backend's
 * agent-hours situation buckets (PR1). `near` = ≥80% of the limit, `exhausted`
 * = at/over the limit, `has_boost` = an active boost grant, `unmetered` = an
 * unlimited plan, `no_sub` = no active subscription.
 */
export type UsageFilter = 'near' | 'exhausted' | 'has_boost' | 'unmetered' | 'no_sub'

export interface UserProvider {
  providerType: string
  displayName: string
  status: string
}

export interface UserStats {
  // Present in the lightweight list row (admin.list-users).
  apps: number
  channels: number
  // Filled lazily by admin.get-user-detail when the card is expanded.
  agents?: number
  workspaces?: number
  totalCost?: number
  totalTokens?: number
}

export interface ActivityDay {
  date: string  // YYYY-MM-DD
  count: number
}

/**
 * The billing fields the collapsed list row carries — just enough for the
 * header plan badge. The rest of BillingInfo is filled lazily by
 * admin.get-user-detail when the card is expanded, so those fields are optional.
 */
export interface BillingInfo {
  planId: string
  planName: string
  status: 'active' | 'paused' | 'cancelled' | 'past_due'
  teamId: string | null
  teamName: string | null
  // ── List-row quota fields (PR1) ────────────────────────────────────────────
  /** agentHoursUsed / effectiveLimit as a fraction (0..1+), or null when unmetered/no-limit. */
  pct?: number | null
  /** Active boost hours granted this period (0 = none). */
  boostHours?: number
  /** True for an unlimited plan (no agent-hours cap). */
  unmetered?: boolean
  // ── Lazy (expanded card only) ──────────────────────────────────────────────
  effectivePrice?: number | null
  effectiveLimit?: number | null
  agentHoursUsed?: number
  overageHours?: number
  // Derived from the latest invoice (read-only); Stripe will own it in FASE 4.
  billingStatus?: 'pending' | 'invoiced' | 'paid' | 'waived' | 'overdue'
  billingNotes?: string
  customPrice?: number | null
  customPriceNote?: string | null
  customAgentHoursLimit?: number | null
  terosProviderConfigId?: string | null
  currentPeriodStart?: string
  currentPeriodEnd?: string
  invoices?: Array<{
    _id?: string
    periodStart?: string
    periodEnd?: string
    amount?: number
    status?: string
    paymentMethod?: string
    invoiceNumber?: string
    notes?: string
  }>
}

/** Expensive per-user enrichment loaded on demand (admin.get-user-detail). */
export interface UserDetailEnrichment {
  userId: string
  stats: {
    agents: number
    workspaces: number
    totalCost: number
    totalTokens: number
  }
  billing: BillingInfo | null
}

export interface BillingTeam {
  _id: string
  name: string
  slug: string
  planId: string
  planName: string
  seatPrice: number
  /** Manual per-seat price override (decision E); null = plan price. */
  customSeatPrice?: number | null
  seatCount: number
  maxSeats: number
  status: 'active' | 'paused' | 'cancelled'
  paymentMethod: 'stripe' | 'manual' | 'transfer'
  billingEmail: string
  memberCount: number
  memberIds: string[]
  ownerId: string
  createdAt?: string
  updatedAt?: string
}

export interface TerosProviderConfig {
  _id: string
  name: string
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

/**
 * A plan row from admin.list-plans — the FULL catalogue (incl. hidden internal
 * tiers like plan_unlimited that billing.list-plans filters out). `isPublic`
 * lets the admin picker mark the hidden ones.
 */
export interface AdminPlanOption {
  planId: string
  name: string
  displayName: string
  price: number
  currency: string
  agentHoursLimit: number
  terosModel: boolean
  isPublic: boolean
  contactSales: boolean
}

// ============================================================================
// Team members (admin.get-team-members) — resolves a team's roster + usage
// ============================================================================

export interface TeamMember {
  userId: string
  userName: string | null
  userEmail: string | null
  role: string | null
  isOwner: boolean
  planId: string | null
  planName: string | null
  agentHoursUsed: number | null
  /** Effective limit incl. active boosts. */
  agentHoursLimit: number | null
  usagePct: number | null
  subscriptionStatus: string | null
}

export interface TeamMembersView {
  team: {
    _id: string
    name: string
    slug: string
    planId: string
    planName: string
    seatPrice: number
    customSeatPrice: number | null
    seatCount: number
    maxSeats: number
    status: 'active' | 'paused' | 'cancelled'
    paymentMethod: 'stripe' | 'manual' | 'transfer'
    billingEmail: string
    ownerId: string
  }
  /** The future "company admin" — resolved even when not a member. */
  owner: { userId: string; userName: string | null; userEmail: string | null } | null
  members: TeamMember[]
}

// ============================================================================
// Billing audit (admin.get-billing-audit) — explains how agentHoursUsed formed
// ============================================================================

export interface BillingAuditSubscription {
  _id: string
  userId: string
  userName: string | null
  userEmail: string | null
  planId: string
  planName: string | null
  status: string
  agentHoursUsed: number
  /** Effective limit incl. active boosts. */
  agentHoursLimit: number
  boostHours: number
  overageHours: number
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  lastBilledHourBucket: string | null
}

export interface BillingAuditBoost {
  _id: string
  hours: number
  periodStart: string
  periodEnd: string
  grantedBy: string
  /** Set for an admin grant; null for a self-serve purchase. */
  accessRequestId: string | null
  /** Set for a self-serve purchase (its _id IS the purchaseId); null for a grant. */
  purchaseId: string | null
  /** Origin of the boost — drives the period card's origin badge. */
  source: 'access_request' | 'purchase' | 'admin_grant'
  /** Free-text reason captured on grant; null when none. */
  note: string | null
  createdAt: string
}

// ── Temporary period hour boost (admin.grant-hour-boost / revoke-hour-boost) ──

/** Params for `admin.grant-hour-boost`. `idempotencyKey` is a client nonce so a
 *  retry with the same key never double-grants (1-128 chars of [A-Za-z0-9_-]). */
export interface GrantHourBoostParams {
  targetUserId: string
  /** Integer in [1, 10000]. */
  hours: number
  note?: string
  idempotencyKey: string
}

export interface GrantHourBoostResult {
  targetUserId: string
  boostId: string
  hours: number
  /** True when the idempotencyKey matched an existing grant (no new hours added). */
  deduped: boolean
  periodEnd: string
}

export interface RevokeHourBoostParams {
  targetUserId: string
  boostId: string
}

export interface RevokeHourBoostResult {
  targetUserId: string
  boostId: string
  status: 'revoked'
  hours: number
}

/** Live recompute of expected (rollups in period) vs actual (agentHoursUsed). */
export interface BillingAuditConsumption {
  expectedHours: number
  actualHours: number
  driftHours: number
}

export interface BillingAuditLedgerEntry {
  hourBucket: string
  fromHourBucket: string | null
  hoursAdded: number
  cumulative: number
  rollupCount: number
  trackerRunId: string
  createdAt: string
}

export interface BillingAuditSnapshot {
  periodStart: string
  periodEnd: string
  agentHoursUsed: number
  agentHoursLimit: number
  overageHours: number
  invoiceId: string | null
  createdAt: string
}

export interface BillingAuditInvoice {
  _id: string
  periodStart: string
  periodEnd: string
  amount: number
  currency: string
  status: string
  paymentMethod: string
  createdAt: string
}

export interface BillingAuditView {
  subscription: BillingAuditSubscription
  activeBoosts: BillingAuditBoost[]
  consumption: BillingAuditConsumption
  ledgerEntries: BillingAuditLedgerEntry[]
  ledgerTotalCount: number
  ledgerTruncated: boolean
  snapshots: BillingAuditSnapshot[]
  invoices: BillingAuditInvoice[]
}

export interface UserSummary {
  userId: string
  profile: {
    displayName?: string
    email?: string
    avatarUrl?: string
    [key: string]: any
  }
  role: UserRole
  status: UserStatus
  badges?: Array<'founding_partner' | 'early_bird'>
  emailVerified: boolean
  accessGranted: boolean
  lastLoginAt?: string
  createdAt: string
  updatedAt: string
  providers: UserProvider[]
  stats: UserStats
  activity: ActivityDay[]
  billing: BillingInfo | null
}

export interface UserDetail {
  userId: string
  profile: {
    displayName?: string
    email?: string
    avatarUrl?: string
    [key: string]: any
  }
  role: UserRole
  status: UserStatus
  emailVerified: boolean
  accessGranted: boolean
  lastLoginAt?: string
  createdAt: string
  updatedAt: string
}

export interface UserAppInfo {
  appId: string
  name: string
  mcaId: string
  status: string
  createdAt: string
}

// ============================================================================
// Agent usage instrumentation (admin-api.agent-usage-*)
// ============================================================================

export type AgentUsageProvider = string
export type AgentUsageTriggerKind =
  | 'user_message'
  | 'delegation'
  | 'autorun'
  | 'scheduled'
  | 'event_subscription'
export type AgentUsageSessionStatus =
  | 'running'
  | 'completed'
  | 'errored'
  | 'timed_out'
  | 'aborted'
export type AgentUsageTimeMetric = 'userActive' | 'agentActive'
export type AgentUsageGroupBy = 'hour' | 'day' | 'week'
export type AgentUsageFormat = 'native' | 'otel'

export interface AgentUsageQueryParams {
  userId?: string
  agentId?: string
  workspaceId?: string
  provider?: AgentUsageProvider
  triggerKind?: AgentUsageTriggerKind
  from: string  // ISO
  to: string    // ISO
  groupBy?: AgentUsageGroupBy
  timeMetric?: AgentUsageTimeMetric
  statuses?: AgentUsageSessionStatus[]
  timeZone?: string
  format?: AgentUsageFormat
  limit?: number
  skip?: number
}

export interface AgentUsageBucket {
  bucket: string
  groupKey?: {
    userId?: string
    agentId?: string
    provider?: string
    workspaceId?: string
  }
  inputTokens: number
  outputTokens: number
  cachedReadTokens: number
  totalTokens: number
  costUsd: number
  activeMs: number
  activeHours: number
  sessionCount: number
  tokensPerActiveHour: number | null
}

/** Derived percentile set for a latency/TTFT distribution (TER-616/F1). `null` when no samples. */
export interface ModelHealthPercentiles {
  count: number
  p50: number | null
  p95: number | null
  p99: number | null
  mean: number | null
  /** Per-bucket counts aligned to LATENCY_BUCKET_BOUNDS_MS (+overflow). For the heatmap (R7.1). */
  buckets?: number[]
  /** Samples above the last finite bound `(81920ms, +inf)`. `>0` ⇒ a capped tail (A3.1). */
  overflowCount?: number
  /** Largest sample observed (ms), or `null`/absent — the true tail ceiling (A3.1). */
  max?: number | null
  /** `true` when `p99` is an overflow clamp (`81920ms`), not the real figure → render "≥…" (A3.1). */
  p99Capped?: boolean
}

/** Upstream status-page indicator (R9). */
export type UpstreamIndicator =
  | 'operational'
  | 'degraded'
  | 'partial_outage'
  | 'major_outage'
  | 'maintenance'
  | 'unknown'

/** Per-`actualProvider×modelId` health over the range (TER-616/F1). */
export interface ModelHealthSummary {
  /** Real upstream provider (`fireworks` | `together` | …). */
  actualProvider: string
  modelId: string
  requestCount: number
  /** Turns per minute over the queried window (`requestCount / periodMinutes`) — F1.1. */
  throughputPerMin?: number
  latency: ModelHealthPercentiles
  ttft: ModelHealthPercentiles
  statusCounts: Record<string, number>
  errorCounts: Record<string, number>
  /** Errored turns per honest-attribution sub-reason (TER-698/TER-700): capacity / billing / model_unavailable / … */
  subReasonCounts?: Record<string, number>
  /** Provider finish_reason breakdown (`length` = truncation, §3.1). */
  finishReasons?: Record<string, number>
  /** (errored + timed_out) / requests (R8.4). */
  errorRate: number
  /** completed / (requests − aborted), or `null` for an all-aborted bucket → "—" (A3.3). */
  successRate: number | null
  timeoutRate?: number
  abortRate?: number
  /** (rate_limited + overloaded) / requests — capacity saturation (R6.2). */
  saturationRate?: number
  /** failover turns / requests (R3.5). */
  fallbackRate?: number
  /** empty completions / measurable turns, or `null` when nothing measurable (§3.1, A3.3). */
  emptyRate?: number | null
  /** truncated turns / turns with a known finish_reason, or `null` (§3.1, A3.3). */
  truncationRate?: number | null
  /** failing tools / total tools (R4.3). */
  toolErrorRate?: number
  toolCallCount?: number
  /** 👍/👎 on this upstream×model's messages over the range (R4.4). */
  thumbsUp?: number
  thumbsDown?: number
}

/** Per-upstream status-page indicators (R9). */
export interface UpstreamStatus {
  fireworks: UpstreamIndicator
  together: UpstreamIndicator
}

export interface AgentUsageModelHealthResponse {
  filters: AgentUsageQueryParams
  models: ModelHealthSummary[]
  /** Length of the queried window in minutes — denominator for the global throughput KPI (F1.1). */
  periodMinutes: number
  /** Upstream incident badge data (R9). Absent if the probe was unavailable. */
  upstreamStatus?: UpstreamStatus
  source: 'rollup'
}

/** One recent upstream provider error, for the ops feed (TER-700). */
export interface UpstreamErrorRow {
  time?: string
  provider?: string
  model?: string
  errorKind?: string
  errorSubReason?: string
  upstreamMessage?: string
}

export interface AgentUsageUpstreamErrorsResponse {
  items: UpstreamErrorRow[]
  limit: number
}

/** One hour of the model-health time-series (F1.2). */
export interface ModelHealthHourBucket {
  /** Hour bucket, ISO-8601 UTC (the rollup's own bucket; render in `bucketTimeZone`). */
  hourBucket: string
  /** Per-`actualProvider×modelId` health for THIS hour only. */
  models: ModelHealthSummary[]
}

export interface AgentUsageModelHealthTimeseriesResponse {
  filters: AgentUsageQueryParams
  /** Ascending chronological order, one entry per hour with activity. */
  series: ModelHealthHourBucket[]
  bucketTimeZone: string
  source: 'rollup'
}

/**
 * Live in-flight LLM streams per real upstream (F1.3). A point-in-time snapshot
 * of the backend's in-memory gauge (NOT `status='running'`), so the window polls
 * it. `total` sums every upstream; `capturedAt` dates the reading.
 */
export interface AgentUsageInflightResponse {
  inflight: Record<string, number>
  total: number
  capturedAt: string
}

export interface AgentUsageTokensPerHourResponse {
  filters: AgentUsageQueryParams
  buckets: AgentUsageBucket[]
  bucketTimeZone: string
  /** 'rollup+live' when the in-progress hour was folded in from raw sessions. */
  source: 'rollup' | 'rollup+live'
}

export interface SessionTokenBreakdown {
  system: number
  tools: number
  examples: number
  memory: number
  summary: number
  conversation: number
  toolCalls: number
  toolResults: number
  output: number
}

export interface AgentUsageSessionSummary {
  sessionUsageId: string
  parentSessionUsageId: string | null
  triggerKind: AgentUsageTriggerKind
  userId: string
  agentId: string
  workspaceId: string
  channelId: string
  provider: string
  modelId: string
  actualModel?: string
  /** Real upstream that served the turn (fireworks|together|…); absent when the provider has no split. */
  actualProvider?: string
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  status: AgentUsageSessionStatus
  errorKind?: string
  errorMessage?: string
  inputTokens: number
  outputTokens: number
  /** Tokens leídos del cache del provider (Anthropic prompt caching). */
  cachedReadTokens?: number
  /** Tokens escritos al cache (cost one-time, future savings). */
  cachedWriteTokens?: number
  totalTokens: number
  costUsd: number
  descendantSessionCount: number
  llmCallCount: number
  toolCallCount: number
  tokenBreakdown?: SessionTokenBreakdown
  /**
   * True when the turn completed WITHOUT the provider reporting usage
   * (0 tokens recorded). The UI must render "not measured" — never a real 0
   * or $0.00 (2026-07-07 audit, N8).
   */
  usagePartial?: boolean
}

// ── Session trace (admin-api.agent-usage-session-detail) — F2 drill-down ──────

export interface TraceLlmCall {
  usageId: string
  step: number | null
  provider: string
  actualProvider?: string
  modelId: string
  actualModel?: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens?: number
  costTotal: number
  latencyMs?: number
  ttftMs?: number
  stopReason?: string
  fallbackUsed?: boolean
  messageId: string
  /** The assistant message this call produced (from channel_messages). `text` is null for non-text content. */
  message: {
    id: string
    role: string
    createdAt: number | null
    text: string | null
    contentType: string
  } | null
  feedback: { rating: 'up' | 'down'; comment?: string; reasons?: string[] } | null
}

export interface TraceToolCall {
  toolExecutionId: string
  stepIndex: number
  toolCallIndex: number
  toolName: string
  mcaId?: string
  status: 'running' | 'success' | 'error' | 'permission_denied' | 'aborted'
  durationMs: number | null
  errorMessage?: string
  inputSizeBytes?: number
  outputSizeBytes?: number
}

export type TraceEvent =
  | { kind: 'llm'; at: string; llm: TraceLlmCall }
  | { kind: 'tool'; at: string; tool: TraceToolCall }

export interface TraceChild {
  sessionUsageId: string
  agentId: string
  /** Backend-resolved agent display name (P6); absent → raw id. */
  agentName?: string
  triggerKind: AgentUsageTriggerKind
  status: AgentUsageSessionStatus
  modelId: string
  actualProvider?: string
  totalTokens: number
  costUsd: number
  startedAt: string
  durationMs: number | null
}

/** The session header of a trace: the list summary + the F0/F1 turn telemetry fields. */
export type TraceSession = AgentUsageSessionSummary & {
  actualProvider?: string
  latencyMs?: number
  ttftMs?: number
  stopReason?: string
  fallbackUsed?: boolean
  errorKind?: string
  errorMessage?: string
}

/**
 * Latitude "known signal" badge (F4·C1 return path). Content-free structural
 * fields only — the backend never sends UI strings. Present when Latitude has
 * clustered this trace's failures into a signal; the frontend composes the
 * phrase. `null`/absent → no badge (Latitude down → view identical).
 */
export interface LatitudeSignalBadge {
  slug: string
  name: string
  priority: string | null
  source: string
  deepLinkUrl: string
  trigger: string
}

/** Full drill-down of one turn (F2). Dates arrive as ISO strings over the wire. */
export interface SessionTrace {
  session: TraceSession
  /** Backend-resolved display names (P6); absent → fall back to the raw id. */
  agentName?: string
  userName?: string
  workspaceName?: string
  events: TraceEvent[]
  children: TraceChild[]
  /** F4·C1 — Latitude clustered-failure badge, when known. */
  latitudeSignal?: LatitudeSignalBadge | null
}

/**
 * One clustered-failure signal in the F4·C2 dashboard. Structural data only (the
 * frontend composes the phrasing); `deepLinkUrl` opens it in the Latitude web UI.
 */
export interface LatitudeSignalSummary {
  id: string
  slug: string
  name: string
  description: string
  /** `annotation` | `flagger` | `custom` (kept open for upstream additions). */
  source: string
  /** Any of `new` | `escalating` | `ongoing` (can hold several at once). */
  states: string[]
  muted: boolean
  occurrences: number
  /** Share of sessions touched, in [0, 1]. */
  affectedSessionsPercent: number
  trend: Array<{ bucket: string; count: number }>
  tags: string[]
  firstSeenAt: string | null
  lastSeenAt: string | null
  deepLinkUrl: string
}

export interface LatitudeSignalsListParams {
  limit?: number
  cursor?: string | null
  lifecycleGroup?: 'active' | 'archived'
  sortBy?: 'lastSeen' | 'occurrences' | 'state'
  sortDirection?: 'asc' | 'desc'
  query?: string
}

/**
 * `status` distinguishes not-configured / unauthorized / unreachable / ok so the
 * dashboard renders the right empty state instead of inferring from an empty list.
 */
export interface LatitudeSignalsListResponse {
  status: 'ok' | 'unconfigured' | 'unauthorized' | 'unreachable'
  signals: LatitudeSignalSummary[]
  nextCursor: string | null
  hasMore: boolean
}

export interface ToolExecutionSummary {
  toolExecutionId: string
  sessionUsageId: string
  channelId: string
  userId: string
  agentId: string
  workspaceId: string
  stepIndex: number
  toolCallIndex: number
  toolName: string
  mcaId?: string
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  status: 'running' | 'success' | 'error' | 'permission_denied' | 'aborted'
  errorMessage?: string
  inputSizeBytes?: number
  outputSizeBytes?: number
}

export interface AgentUsageHealthResponse {
  buffer: {
    events_enqueued: number
    events_flushed: number
    events_dropped: number
    events_retried: number
    flush_errors: number
    flush_latency_ms_p50: number
    flush_latency_ms_p95: number
    queue_depth: number
    queue_depth_high_water: number
    dead_letter_total_size_bytes: number
  }
  reconcile: {
    reconcile_sessions_closed: number
    reconcile_tools_closed: number
    reconcile_errors: number
    reconcile_last_run_at: number | null
    reconcile_skipped_not_leader: number
  }
  rollup: {
    rollup_job_duration_ms: number
    rollup_docs_written: number
    rollup_errors: number
    rollup_lag_hours: number
    rollup_last_run_at: number | null
    rollup_skipped_not_leader: number
  }
}

// ============================================================================
// AdminApi
// ============================================================================

export class AdminApi {
  constructor(private readonly transport: Transport) {}

  // --------------------------------------------------------------------------
  // User management
  // --------------------------------------------------------------------------

  /** List all users with stats (admin only) */
  /**
   * One page of lightweight user rows. `search` matches name/email,
   * `status`/`role` filter, `page` is 0-based. The expensive per-user data
   * (agents/workspaces/cost, full billing) is loaded via getUserDetail on expand.
   */
  listUsers(params?: {
    search?: string
    status?: UserStatus
    role?: UserRole
    /** Filter by plan id (from the plan catalogue / distinct plans seen in the list). */
    plan?: string
    /** Filter by agent-hours situation bucket (PR1). */
    usage?: UsageFilter
    page?: number
    pageSize?: number
  }): Promise<{
    users: UserSummary[]
    total: number
    page: number
    pageSize: number
    summary: { total: number; active: number; admins: number; nearLimit: number; exhausted: number }
  }> {
    return this.transport.request('admin.list-users', (params ?? {}) as Record<string, unknown>)
  }

  /** Expensive enrichment for one user, loaded when their card is expanded. */
  getUserDetail(targetUserId: string): Promise<UserDetailEnrichment> {
    return this.transport.request('admin.get-user-detail', { targetUserId })
  }

  /**
   * List agents. Default: active only. `includeAll:true` para super admin
   * (incluye archived + status:undefined legacy).
   */
  listAllAgents(opts: { includeAll?: boolean } = {}): Promise<{
    agents: Array<{
      agentId: string
      name?: string
      fullName?: string
      workspaceId?: string
      coreId?: string
    }>
  }> {
    return this.transport.request(
      'admin-api.agents-list',
      opts as unknown as Record<string, unknown>,
    )
  }

  /**
   * List workspaces. Default: active only. `includeAll:true` para super admin.
   */
  listAllWorkspaces(opts: { includeAll?: boolean } = {}): Promise<{
    workspaces: Array<{ workspaceId: string; name?: string }>
  }> {
    return this.transport.request(
      'admin-api.workspaces-list',
      opts as unknown as Record<string, unknown>,
    )
  }

  /** Get detailed info for a specific user (admin only) */
  getUser(targetUserId: string): Promise<{
    user: UserDetail
    stats: { apps: number; sessions: number; credentials: number }
    apps: UserAppInfo[]
  }> {
    return this.transport.request('admin.get-user', { targetUserId })
  }

  /** Update a user's role (super only) */
  updateUserRole(
    targetUserId: string,
    role: UserRole,
  ): Promise<{ user: { userId: string; role: UserRole } }> {
    return this.transport.request('admin.update-user-role', { targetUserId, role })
  }

  /** Grant platform access to a waitlisted user (admin only) */
  grantAccess(targetUserId: string): Promise<{ user: { userId: string; accessGranted: boolean } }> {
    return this.transport.request('admin.grant-access', { targetUserId })
  }

  /** Update a user's status (admin only) */
  updateUserStatus(
    targetUserId: string,
    status: UserStatus,
  ): Promise<{ user: { userId: string; status: UserStatus } }> {
    return this.transport.request('admin.update-user-status', { targetUserId, status })
  }

  /**
   * Start impersonating a user (super only).
   * Returns a short-lived impersonation token and the target user info.
   */
  impersonate(targetUserId: string): Promise<{
    impersonationToken: string
    targetUser: {
      userId: string
      displayName: string
      email: string
      avatarUrl?: string
      role: string
    }
    expiresAt: string
  }> {
    return this.transport.request('admin.impersonate', { targetUserId })
  }

  /**
   * Stop the current impersonation session (super only).
   * The backend identifies the admin from the current session.
   * Returns a fresh token for the original admin.
   */
  stopImpersonation(): Promise<{
    restoredToken: string
  }> {
    return this.transport.request('admin.stop-impersonation')
  }

  // --------------------------------------------------------------------------
  // Billing subscription management (admin only)
  // --------------------------------------------------------------------------

  /** Update a user's billing subscription (admin only) */
  updateBillingSubscription(params: {
    targetUserId: string
    planId?: string
    customPrice?: number | null
    customPriceNote?: string | null
    customAgentHoursLimit?: number | null
    billingNotes?: string
    status?: 'active' | 'paused' | 'cancelled' | 'past_due'
    terosProviderConfigId?: string | null
    teamId?: string | null
  }): Promise<{
    userId: string
    subscription: BillingInfo
  }> {
    return this.transport.request('admin.update-billing-subscription', params as unknown as Record<string, unknown>)
  }

  /**
   * Billing audit for one user: explains how agentHoursUsed formed (live recompute
   * + the period ledger), plus the subscription, active boosts, recent snapshots
   * and invoices. Resolve by userId (active sub) or an explicit subscriptionId.
   */
  getBillingAudit(params: {
    userId?: string
    subscriptionId?: string
    limit?: number
  }): Promise<BillingAuditView> {
    return this.transport.request('admin.get-billing-audit', params as unknown as Record<string, unknown>)
  }

  /**
   * Grant a user extra agent-hours for the CURRENT period only (they expire at
   * renewal and do NOT change the permanent `customAgentHoursLimit`). The
   * `idempotencyKey` is a client nonce — a retry with the same key never
   * double-grants. Refuses unmetered plans (GRANT_NOT_APPLICABLE).
   */
  grantHourBoost(params: GrantHourBoostParams): Promise<GrantHourBoostResult> {
    return this.transport.request('admin.grant-hour-boost', params as unknown as Record<string, unknown>)
  }

  /** Revoke an active period hour boost — the effective limit drops by its hours. */
  revokeHourBoost(params: RevokeHourBoostParams): Promise<RevokeHourBoostResult> {
    return this.transport.request('admin.revoke-hour-boost', params as unknown as Record<string, unknown>)
  }

  // --------------------------------------------------------------------------
  // Billing team management (admin only)
  // --------------------------------------------------------------------------

  /**
   * Full plan catalogue incl. hidden internal tiers (admin only). The admin plan
   * picker needs the hidden tiers (e.g. plan_unlimited) that the user-facing
   * billing.list-plans filters out by isPublic.
   */
  listPlans(): Promise<{ plans: AdminPlanOption[] }> {
    return this.transport.request('admin.list-plans')
  }

  /** List all billing teams (admin only) */
  listBillingTeams(): Promise<{ teams: BillingTeam[] }> {
    return this.transport.request('admin.list-billing-teams')
  }

  /** Resolve a team's members with their plan + live usage (admin only) */
  getTeamMembers(teamId: string): Promise<TeamMembersView> {
    return this.transport.request('admin.get-team-members', { teamId })
  }

  /** Create a billing team (admin only) */
  createBillingTeam(params: {
    name: string
    slug: string
    planId: string
    maxSeats: number
    memberIds?: string[]
    billingEmail?: string
    paymentMethod?: 'stripe' | 'manual' | 'transfer'
    customSeatPrice?: number | null
  }): Promise<{ team: BillingTeam }> {
    return this.transport.request('admin.create-billing-team', params as unknown as Record<string, unknown>)
  }

  /** Update a billing team (admin only) */
  updateBillingTeam(params: {
    teamId: string
    name?: string
    planId?: string
    maxSeats?: number
    addMemberIds?: string[]
    removeMemberIds?: string[]
    status?: 'active' | 'paused' | 'cancelled'
    billingEmail?: string
    paymentMethod?: 'stripe' | 'manual' | 'transfer'
    customSeatPrice?: number | null
  }): Promise<{ team: BillingTeam }> {
    return this.transport.request('admin.update-billing-team', params as unknown as Record<string, unknown>)
  }

  /** Delete a billing team (admin only) */
  deleteBillingTeam(teamId: string): Promise<{ deleted: boolean; teamId: string }> {
    return this.transport.request('admin.delete-billing-team', { teamId })
  }

  // --------------------------------------------------------------------------
  // Teros provider config management (admin only)
  // --------------------------------------------------------------------------

  /** List all Teros provider configs */
  listTerosProviderConfigs(): Promise<{ configs: TerosProviderConfig[] }> {
    return this.transport.request('admin.list-teros-provider-configs')
  }

  /** Create a new Teros provider config (always non-default) */
  createTerosProviderConfig(
    name: string,
    fireworksApiKey: string,
  ): Promise<{ config: TerosProviderConfig }> {
    return this.transport.request('admin.create-teros-provider-config', { name, fireworksApiKey })
  }

  /** Update a Teros provider config */
  updateTerosProviderConfig(
    configId: string,
    updates: {
      name?: string
      fireworksApiKey?: string
      isDefault?: boolean
    },
  ): Promise<{ config: TerosProviderConfig }> {
    return this.transport.request('admin.update-teros-provider-config', { configId, ...updates })
  }

  /** Delete a Teros provider config */
  deleteTerosProviderConfig(configId: string): Promise<{ deleted: boolean; configId: string }> {
    return this.transport.request('admin.delete-teros-provider-config', { configId })
  }

  // --------------------------------------------------------------------------
  // Agent usage instrumentation (admin-api.agent-usage-*)
  // --------------------------------------------------------------------------

  /**
   * Token / activity buckets aggregated from `agent_usage_rollups_hourly`
   * (`timeMetric='agentActive'`) or `agent_usage_rollups_user_hourly`
   * (`timeMetric='userActive'`).
   */
  agentUsageTokensPerHour(
    params: AgentUsageQueryParams,
  ): Promise<AgentUsageTokensPerHourResponse> {
    return this.transport.request(
      'admin-api.agent-usage-tokens-per-hour',
      params as unknown as Record<string, unknown>,
    )
  }

  /**
   * Paginated raw sessions from `agent_usage_sessions`. Use `format='otel'` to
   * receive OTel GenAI shape instead of the native projection.
   */
  listAgentUsageSessions(
    params: AgentUsageQueryParams,
  ): Promise<{ items: AgentUsageSessionSummary[]; limit: number; skip: number }> {
    return this.transport.request(
      'admin-api.agent-usage-list-sessions',
      params as unknown as Record<string, unknown>,
    )
  }

  /**
   * Paginated tool executions from `tool_executions`.
   */
  listToolExecutions(
    params: AgentUsageQueryParams,
  ): Promise<{ items: ToolExecutionSummary[]; limit: number; skip: number }> {
    return this.transport.request(
      'admin-api.agent-usage-tool-executions-list',
      params as unknown as Record<string, unknown>,
    )
  }

  /**
   * Buffer + reconciler + rollup health metrics. Source of truth for the
   * AgentUsageWindow's "Subsystem health" snapshot.
   */
  agentUsageHealth(): Promise<AgentUsageHealthResponse> {
    return this.transport.request('admin-api.agent-usage-health')
  }

  /**
   * Per-`actualProvider×modelId` health (latency/TTFT percentiles, error-rate
   * by kind, throughput) over the range — the model-observability window
   * (TER-616/F1). Distinguishes the real upstream behind a logical provider.
   */
  agentUsageModelHealth(
    params: AgentUsageQueryParams,
  ): Promise<AgentUsageModelHealthResponse> {
    return this.transport.request(
      'admin-api.agent-usage-model-health',
      params as unknown as Record<string, unknown>,
    )
  }

  /**
   * Recent upstream provider errors (TER-700) — the ops feed carrying the precise
   * cause the user never sees: `errorSubReason` + the literal `upstreamMessage`.
   */
  agentUsageUpstreamErrors(
    params: AgentUsageQueryParams,
  ): Promise<AgentUsageUpstreamErrorsResponse> {
    return this.transport.request(
      'admin-api.agent-usage-upstream-errors',
      params as unknown as Record<string, unknown>,
    )
  }

  /**
   * Model health PER HOUR over the range (F1.2) — same scope as
   * `agentUsageModelHealth` but one snapshot per hour for the time-series chart.
   */
  agentUsageModelHealthTimeseries(
    params: AgentUsageQueryParams,
  ): Promise<AgentUsageModelHealthTimeseriesResponse> {
    return this.transport.request(
      'admin-api.agent-usage-model-health-timeseries',
      params as unknown as Record<string, unknown>,
    )
  }

  /**
   * Live in-flight LLM-stream count per upstream (F1.3). Point-in-time; the
   * window polls it. No range — it's a snapshot of the backend's gauge now.
   */
  agentUsageInflight(): Promise<AgentUsageInflightResponse> {
    return this.transport.request('admin-api.agent-usage-in-flight')
  }

  /**
   * Full drill-down of one turn (F2): the session + its LLM/tool events
   * interleaved + message text + 👍/👎 + direct subagents. Rejects NOT_FOUND
   * for an unknown sessionUsageId.
   */
  agentUsageSessionDetail(sessionUsageId: string): Promise<SessionTrace> {
    return this.transport.request('admin-api.agent-usage-session-detail', { sessionUsageId })
  }

  /**
   * F4·C2 — a page of Latitude's clustered-failure signals for the dashboard.
   * Never rejects on a Latitude problem: `status` carries unconfigured /
   * unauthorized / unreachable so the UI shows the right empty state.
   */
  latitudeSignalsList(
    params: LatitudeSignalsListParams = {},
  ): Promise<LatitudeSignalsListResponse> {
    return this.transport.request(
      'admin-api.latitude-signals-list',
      params as unknown as Record<string, unknown>,
    )
  }

  /**
   * Cascading access-based directory for AgentUsageWindow filters.
   * Empty params → todo el universo. user/agent/workspace partial filters →
   * subset coherente con membership real (workspaces.members + ownerId).
   */
  agentUsageListAccessibleEntities(params: {
    userId?: string
    agentId?: string
    workspaceId?: string
  }): Promise<{
    // agentHoursLimit: each user's real plan limit for the usage dashboard quota
    // (TER-628); 0 = unmetered / no active sub.
    users: Array<{ userId: string; name: string; agentHoursLimit: number }>
    agents: Array<{ agentId: string; name: string }>
    workspaces: Array<{ workspaceId: string; name: string }>
  }> {
    return this.transport.request(
      'admin-api.agent-usage-list-accessible-entities',
      params as unknown as Record<string, unknown>,
    )
  }

  // --------------------------------------------------------------------------
  // Agent-core rollout (admin-api.feature-flags-* + core-rollout-apply) — TER-412
  // Rollout/override ops require super; the UI handles FORBIDDEN for plain admins.
  // --------------------------------------------------------------------------

  /** List feature flags with their rollout config (super only). */
  listFeatureFlags(): Promise<{
    flags: Array<{
      key: string
      type: string
      defaultValue: unknown
      category?: string
      overrideCount: number
      rollout: { value: unknown; percentage: number } | null
    }>
  }> {
    return this.transport.request('admin-api.feature-flags-list')
  }

  /** Set the percentage rollout of a flag (super only). For `core.*` the value is a coreId. */
  setFeatureFlagRollout(
    key: string,
    value: unknown,
    percentage: number,
  ): Promise<{ success: boolean; key: string; value: unknown; percentage: number }> {
    return this.transport.request('admin-api.feature-flags-set-rollout', { key, value, percentage })
  }

  /** Remove a flag's rollout (super only). */
  clearFeatureFlagRollout(key: string): Promise<{ success: boolean; key: string }> {
    return this.transport.request('admin-api.feature-flags-clear-rollout', { key })
  }

  /** Audit timeline of a flag (super only): set / clear / apply rollout history. */
  getFeatureFlagAuditLog(
    key: string,
    limit = 50,
  ): Promise<{
    key: string
    entries: Array<{
      auditId: string
      key: string
      action: string
      actor: string
      timestamp: string
      note?: string
    }>
  }> {
    return this.transport.request('admin-api.feature-flags-audit-log', { key, limit })
  }

  /** List overrides for a flag (super only). */
  getFeatureFlagOverrides(key: string): Promise<{
    overrides: Array<{ key: string; targetType: string; targetId: string; value: unknown; note?: string }>
  }> {
    return this.transport.request('admin-api.feature-flags-get-overrides', { key })
  }

  /** Create/update an override — used to force a specific user onto a core (super only). */
  setFeatureFlagOverride(
    key: string,
    targetType: 'user' | 'workspace' | 'company',
    targetId: string,
    value: unknown,
    note?: string,
  ): Promise<{ success: boolean }> {
    return this.transport.request('admin-api.feature-flags-set-override', {
      key,
      targetType,
      targetId,
      value,
      note,
    })
  }

  /** Delete an override (super only). */
  deleteFeatureFlagOverride(
    key: string,
    targetType: 'user' | 'workspace' | 'company',
    targetId: string,
  ): Promise<{ success: boolean }> {
    return this.transport.request('admin-api.feature-flags-delete-override', {
      key,
      targetType,
      targetId,
    })
  }

  /** Apply a coreType's rollout: re-point + reprovision its agents (super only). */
  applyCoreRollout(coreType: 'agent' | 'super-agent'): Promise<{
    coreType: string
    migrated: number
    reverted: number
    unchanged: number
    total: number
  }> {
    return this.transport.request('admin-api.core-rollout-apply', { coreType })
  }

  /**
   * Dry-run a coreType's rollout (super only): current distribution + what an Apply
   * would do, without migrating anyone. Pass `hypothetical` (experimental coreId +
   * percentage) to preview a not-yet-saved percentage; omit it to preview the saved
   * rollout (matches what applyCoreRollout would execute).
   */
  previewCoreRollout(
    coreType: 'agent' | 'super-agent',
    hypothetical?: { experimentalCoreId: string; percentage: number },
  ): Promise<{
    coreType: string
    total: number
    distribution: Array<{ coreId: string; count: number }>
    plan: { migrate: number; revert: number; stay: number }
    resulting: Array<{ coreId: string; count: number }>
    unbucketed: number
  }> {
    return this.transport.request('admin-api.core-rollout-preview', {
      coreType,
      ...(hypothetical ?? {}),
    })
  }

  /**
   * The per-agent rollout cohort (super only): WHICH users/agents a rollout touches
   * — current/target core, move kind, owner name, deterministic bucket — not just
   * counts. Omit `hypothetical` for the saved rollout (who is on the experimental
   * now + who an Apply would move).
   */
  cohortCoreRollout(
    coreType: 'agent' | 'super-agent',
    hypothetical?: { experimentalCoreId: string; percentage: number },
  ): Promise<{
    coreType: string
    cohort: Array<{
      agentId: string
      agentName: string
      ownerId: string | null
      ownerName: string
      current: string
      target: string
      kind: 'migrate' | 'revert' | 'stay'
      bucket: number | null
    }>
  }> {
    return this.transport.request('admin-api.core-rollout-cohort', {
      coreType,
      ...(hypothetical ?? {}),
    })
  }
}
