import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

// =============================================================================
// STATUS CLASSIFICATION THRESHOLDS
// =============================================================================
// These thresholds drive the healthy / degraded / down classification per
// provider×model and the overall platform verdict (green / yellow / red).
// They are intentionally simple, documented here, and easy to tune.
//
// Current values (adjust based on operational experience):
//
//   ERROR_RATE_DEGRADED         — errorRate ≥ 5%  → at least degraded
//   P95_TTFT_DEGRADED_MS        — p95 TTFT ≥ 30s  → at least degraded
//   ERROR_RATE_DOWN             — errorRate ≥ 20% → down (severe)
//   RECENT_ERROR_CLUSTER_COUNT  — ≥ 3 same-kind errors in the last 1h → down
//   RECENT_ERROR_WINDOW_HOURS   — look-back window for error clustering (1h)
//
// "down" always takes precedence over "degraded".
// A model with 0 requests in the window is classified "healthy" (no signal).
// =============================================================================

const ERROR_RATE_DEGRADED = 0.05;        // 5%
const P95_TTFT_DEGRADED_MS = 30_000;     // 30 seconds
const ERROR_RATE_DOWN = 0.20;            // 20%
const RECENT_ERROR_CLUSTER_COUNT = 3;    // ≥ 3 same-kind errors in last 1h
const RECENT_ERROR_WINDOW_HOURS = 1;     // look-back for error clustering
const DEFAULT_RECENT_ERRORS_LIMIT = 20;  // max recent errors to return

type ModelStatus = 'healthy' | 'degraded' | 'down';
type OverallStatus = 'green' | 'yellow' | 'red';

export const adminProviderStatus: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a complete LLM provider health overview in a single call. Composes three backend actions ' +
    '(model-health, upstream-errors, in-flight) and returns: per-provider×model health metrics with ' +
    'classified status (healthy/degraded/down), recent upstream errors, live in-flight stream counts, ' +
    'and an overall platform verdict (green/yellow/red) with context. ' +
    'Parameters: periodHours (default 24), optional provider/model filters. ' +
    'Degrades gracefully — if one backend action fails, returns the rest with partial: true. ' +
    'Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      periodHours: {
        type: 'number',
        description: 'Time window in hours for health metrics and error retrieval (default 24).',
      },
      provider: {
        type: 'string',
        description: 'Filter by logical provider name (optional, e.g. "fireworks", "openai").',
      },
      model: {
        type: 'string',
        description: 'Filter by model ID (optional, applied client-side on results).',
      },
    },
    required: [],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');

    const periodHours =
      typeof args.periodHours === 'number' && args.periodHours > 0 ? args.periodHours : 24;
    const provider = typeof args.provider === 'string' ? args.provider : undefined;
    const modelFilter = typeof args.model === 'string' ? args.model : undefined;

    // ── Compute time window ──
    const now = new Date();
    const from = new Date(now.getTime() - periodHours * 3_600_000);
    const toIso = now.toISOString();
    const fromIso = from.toISOString();

    // ── Build params for each backend action ──
    const healthParams: Record<string, unknown> = { from: fromIso, to: toIso };
    if (provider) healthParams.provider = provider;

    const errorParams: Record<string, unknown> = {
      from: fromIso,
      to: toIso,
      limit: DEFAULT_RECENT_ERRORS_LIMIT,
    };
    if (provider) errorParams.provider = provider;

    // ── Call all 3 actions in parallel ──
    // Promise.allSettled so one failure doesn't kill the entire response.
    const [healthResult, errorsResult, inFlightResult] = await Promise.allSettled([
      adminRequest('admin-api.agent-usage-model-health', healthParams),
      adminRequest('admin-api.agent-usage-upstream-errors', errorParams),
      adminRequest('admin-api.agent-usage-in-flight', {}),
    ]);

    const partialErrors: string[] = [];
    let models: any[] = [];
    let recentErrors: any[] = [];
    let inFlight: any = null;

    // ── Process model-health ──
    if (healthResult.status === 'fulfilled') {
      const health = healthResult.value as Record<string, unknown>;
      models = Array.isArray(health.models) ? health.models : [];
      if (modelFilter) {
        models = models.filter((m: any) => m.modelId === modelFilter);
      }
    } else {
      const reason = healthResult.reason instanceof Error ? healthResult.reason.message : String(healthResult.reason);
      partialErrors.push(`model-health failed: ${reason}`);
    }

    // ── Process upstream-errors ──
    if (errorsResult.status === 'fulfilled') {
      const errors = errorsResult.value as Record<string, unknown>;
      recentErrors = Array.isArray(errors.items) ? errors.items : [];
      if (modelFilter) {
        recentErrors = recentErrors.filter((e: any) => e.model === modelFilter);
      }
    } else {
      const reason =
        errorsResult.reason instanceof Error ? errorsResult.reason.message : String(errorsResult.reason);
      partialErrors.push(`upstream-errors failed: ${reason}`);
    }

    // ── Process in-flight ──
    if (inFlightResult.status === 'fulfilled') {
      inFlight = inFlightResult.value;
    } else {
      const reason =
        inFlightResult.reason instanceof Error ? inFlightResult.reason.message : String(inFlightResult.reason);
      partialErrors.push(`in-flight failed: ${reason}`);
    }

    // ── Error cluster detection (→ down) ──
    // Check for a cluster of same-kind errors in the last RECENT_ERROR_WINDOW_HOURS.
    // If ≥ RECENT_ERROR_CLUSTER_COUNT same-kind errors for the same provider×model
    // landed in that window, that model is classified "down".
    const clusterCutoff = new Date(now.getTime() - RECENT_ERROR_WINDOW_HOURS * 3_600_000);
    const clusterByKey = new Map<string, number>(); // "provider::model::errorKind" → count

    for (const err of recentErrors) {
      const errTime = new Date(err.time);
      if (errTime >= clusterCutoff) {
        const key = `${err.provider}::${err.model}::${err.errorKind}`;
        clusterByKey.set(key, (clusterByKey.get(key) ?? 0) + 1);
      }
    }

    const downModels = new Set<string>(); // "provider::model" keys
    for (const [key, count] of clusterByKey) {
      if (count >= RECENT_ERROR_CLUSTER_COUNT) {
        const parts = key.split('::');
        downModels.add(`${parts[0]}::${parts[1]}`);
      }
    }

    // ── Classify each model ──
    const modelSummaries = models.map((m: any) => {
      const p95Ttft: number | null = m.ttft?.p95 ?? null;
      const p95Latency: number | null = m.latency?.p95 ?? null;
      const errorRate: number = m.errorRate ?? 0;
      const successRate: number | null = m.successRate ?? null;
      const requestCount: number = m.requestCount ?? 0;

      const modelKey = `${m.actualProvider}::${m.modelId}`;
      const hasErrorCluster = downModels.has(modelKey);

      let status: ModelStatus = 'healthy';
      const reasons: string[] = [];

      // Down: severe error rate or error cluster in last hour
      if (errorRate >= ERROR_RATE_DOWN) {
        status = 'down';
        reasons.push(`errorRate ${(errorRate * 100).toFixed(1)}% ≥ ${ERROR_RATE_DOWN * 100}%`);
      }
      if (hasErrorCluster) {
        status = 'down';
        reasons.push(
          `error cluster (≥${RECENT_ERROR_CLUSTER_COUNT} same-kind errors in last ${RECENT_ERROR_WINDOW_HOURS}h)`,
        );
      }

      // Degraded: moderate error rate or high TTFT (only if not already down)
      if (status !== 'down') {
        if (errorRate >= ERROR_RATE_DEGRADED) {
          status = 'degraded';
          reasons.push(`errorRate ${(errorRate * 100).toFixed(1)}% ≥ ${ERROR_RATE_DEGRADED * 100}%`);
        }
        if (p95Ttft !== null && p95Ttft >= P95_TTFT_DEGRADED_MS) {
          status = 'degraded';
          reasons.push(`p95 TTFT ${(p95Ttft / 1000).toFixed(1)}s ≥ ${P95_TTFT_DEGRADED_MS / 1000}s`);
        }
      }

      return {
        provider: m.actualProvider,
        model: m.modelId,
        requestCount,
        errorRate,
        successRate,
        p95LatencyMs: p95Latency,
        p95TtftMs: p95Ttft,
        status,
        statusReason: reasons.length > 0 ? reasons.join('; ') : 'all metrics within thresholds',
        errorCounts: m.errorCounts ?? {},
        saturationRate: m.saturationRate ?? 0,
        timeoutRate: m.timeoutRate ?? 0,
        throughputPerMin: m.throughputPerMin ?? null,
      };
    });

    // ── Overall platform verdict ──
    let overallStatus: OverallStatus = 'green';
    const overallReasons: string[] = [];

    if (modelSummaries.length === 0 && partialErrors.length === 0) {
      overallStatus = 'green';
      overallReasons.push('No LLM activity in the queried window.');
    } else if (modelSummaries.length === 0 && partialErrors.length > 0) {
      overallStatus = 'yellow';
      overallReasons.push('Unable to retrieve model health data.');
    } else {
      const downList = modelSummaries.filter((m) => m.status === 'down');
      const degradedList = modelSummaries.filter((m) => m.status === 'degraded');

      if (downList.length > 0) {
        overallStatus = 'red';
        overallReasons.push(
          `${downList.length} model(s) down: ${downList.map((m) => `${m.provider}/${m.model}`).join(', ')}.`,
        );
      } else if (degradedList.length > 0) {
        overallStatus = 'yellow';
        overallReasons.push(
          `${degradedList.length} model(s) degraded: ${degradedList.map((m) => `${m.provider}/${m.model}`).join(', ')}.`,
        );
      } else {
        overallStatus = 'green';
        const totalReqs = modelSummaries.reduce((sum, m) => sum + m.requestCount, 0);
        overallReasons.push(
          `All ${modelSummaries.length} model(s) healthy (${totalReqs} requests in ${periodHours}h).`,
        );
      }
    }

    if (partialErrors.length > 0) {
      if (overallStatus === 'green') overallStatus = 'yellow';
      overallReasons.push(`Partial data: ${partialErrors.join('; ')}`);
    }

    // ── Format recent errors ──
    const formattedErrors = recentErrors.map((e: any) => ({
      time: e.time,
      provider: e.provider,
      model: e.model,
      errorKind: e.errorKind,
      errorSubReason: e.errorSubReason ?? null,
      upstreamMessage: e.upstreamMessage ?? null,
    }));

    // ── Assemble final response ──
    return {
      overall: {
        status: overallStatus,
        summary: overallReasons.join(' '),
      },
      models: modelSummaries,
      recentErrors: formattedErrors,
      inFlight: inFlight
        ? {
            byUpstream: (inFlight as any).inflight,
            total: (inFlight as any).total,
            capturedAt: (inFlight as any).capturedAt,
          }
        : null,
      partial: partialErrors.length > 0,
      ...(partialErrors.length > 0 ? { partialErrors } : {}),
      window: { from: fromIso, to: toIso, periodHours },
    };
  },
};
