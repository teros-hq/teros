/**
 * Isolated OTLP exporter for Latitude (F3a).
 *
 * The ONLY vendor-specific module in the export path (soberanía Principio 3).
 * Everything Latitude-specific is confined here — the ingest URL, the
 * `X-Latitude-Project` header and the Bearer secret. Swapping to Langfuse /
 * Arize / a bare OTLP collector is a diff to `LatitudeExporterConfig` + a
 * re-run of the parser smoke; the span-builder and the hook never change.
 *
 * Design notes:
 *  - A DEDICATED `BasicTracerProvider` — NOT the global SDK, NOT `initLatitude`,
 *    NOT traceloop auto-instrumentation. Nothing here touches global tracing, so
 *    the product keeps zero coupling to Latitude (grep-guard, Principio 2).
 *  - Spans carry DETERMINISTIC ids (span-builder), which the tracer's random
 *    IdGenerator cannot produce. So we build `ReadableSpan`s by hand and push
 *    them straight to a `BatchSpanProcessor` — bypassing the tracer. Two
 *    consequences we handle explicitly here: (a) the provider's `resource` is
 *    NOT auto-attached, so we stamp it in `toReadableSpan`; (b) the provider's
 *    `spanLimits.attributeValueLengthLimit` does NOT apply, so we truncate long
 *    string values ourselves (M-F: an oversized attribute must never blow the
 *    OTLP body and drop the whole batch).
 *  - `BatchSpanProcessor` gives batching + a bounded queue + async export off
 *    the caller's stack. Latitude being down degrades to failed exports, never
 *    to a thrown error in the hook (Principio 2).
 */

import { ExportResultCode } from "@opentelemetry/core"
import { type Resource, resourceFromAttributes } from "@opentelemetry/resources"
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base"
import {
  type Attributes,
  type HrTime,
  SpanKind,
  type SpanStatus,
  SpanStatusCode,
  TraceFlags,
} from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import type { SpanDTO } from "./otel-span-builder.js"

/** Health callbacks — wired to the export metrics mirror in pieza 9. */
export interface LatitudeExporterHooks {
  /** Called with the number of spans handed to the queue on each `export()`. */
  onEnqueue?: (count: number) => void
  /** Called after each batch flush with its result and span count. */
  onExportResult?: (ok: boolean, count: number) => void
}

export interface LatitudeExporterConfig {
  /** Full OTLP traces endpoint, e.g. `http://10.99.0.5:3002/v1/traces`. */
  url: string
  /** Bearer secret for the Latitude ingest. */
  token: string
  /**
   * Latitude project (`X-Latitude-Project`). The env/tenant seam: one project
   * per environment (teros-dev / pre / prod) keeps golden sets clean (F4.3).
   */
  project: string
  /** `service.name` resource attribute. Default `teros-backend`. */
  serviceName?: string
  /** Max spans per export batch. Default 128 (bounded burst memory). */
  maxExportBatchSize?: number
  /** Queue cap; excess spans are dropped by the processor. Default 1024. */
  maxQueueSize?: number
  /** Delay between scheduled flushes (ms). Default 5000. */
  scheduledDelayMillis?: number
  /** Per-batch export timeout (ms). Default 10000. */
  exportTimeoutMillis?: number
  /** Truncate string attribute values longer than this (chars). Default 8192. */
  attributeValueLengthLimit?: number
  hooks?: LatitudeExporterHooks
}

/**
 * What the post-session hook (pieza 6) and the DI wiring (pieza 7) depend on.
 * Deliberately narrow: enqueue spans, flush, shut down. The vendor SDK never
 * leaks past this interface.
 */
export interface SpanTreeExporter {
  export(spans: SpanDTO[]): void
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
}

/** Epoch millis → OTel HrTime `[seconds, nanos]` without double-precision loss. */
function msToHrTime(ms: number): HrTime {
  const seconds = Math.trunc(ms / 1000)
  const nanos = Math.round((ms - seconds * 1000) * 1e6)
  return [seconds, nanos]
}

function hrDuration(start: HrTime, end: HrTime): HrTime {
  let sec = end[0] - start[0]
  let nano = end[1] - start[1]
  if (nano < 0) {
    sec -= 1
    nano += 1e9
  }
  return [sec < 0 ? 0 : sec, nano < 0 ? 0 : nano]
}

/**
 * Copy attributes, truncating over-long string values (M-F). Applied here
 * because manual `ReadableSpan`s skip the provider's `spanLimits`.
 */
function truncateAttributes(attrs: Record<string, SpanDTO["attributes"][string]>, limit: number): Attributes {
  const out: Attributes = {}
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = typeof v === "string" && v.length > limit ? v.slice(0, limit) : v
  }
  return out
}

function toReadableSpan(dto: SpanDTO, resource: Resource, attrLimit: number): ReadableSpan {
  const startTime = msToHrTime(dto.startEpochMs)
  const endTime = msToHrTime(dto.endEpochMs)
  const spanContext = {
    traceId: dto.traceId,
    spanId: dto.spanId,
    traceFlags: TraceFlags.SAMPLED,
  }
  const status: SpanStatus = dto.status
    ? { code: SpanStatusCode.ERROR, ...(dto.status.message ? { message: dto.status.message } : {}) }
    : { code: SpanStatusCode.UNSET }

  return {
    name: dto.name,
    kind: SpanKind.INTERNAL,
    spanContext: () => spanContext,
    parentSpanContext: dto.parentSpanId
      ? { traceId: dto.traceId, spanId: dto.parentSpanId, traceFlags: TraceFlags.SAMPLED }
      : undefined,
    startTime,
    endTime,
    status,
    attributes: truncateAttributes(dto.attributes, attrLimit),
    links: [],
    events: [],
    duration: hrDuration(startTime, endTime),
    ended: true,
    resource,
    instrumentationScope: { name: "teros.latitude-export", version: "1" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  }
}

/**
 * Wraps the real OTLP exporter to surface success/failure per batch to the
 * health metrics (the batch processor swallows results internally).
 */
class CountingSpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly onResult?: (ok: boolean, count: number) => void,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: { code: ExportResultCode }) => void): void {
    this.inner.export(spans, (result) => {
      this.onResult?.(result.code === ExportResultCode.SUCCESS, spans.length)
      resultCallback(result)
    })
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve()
  }
}

/**
 * Build the isolated Latitude exporter. Pure factory: reads no env (the wiring
 * in pieza 12 resolves config from env and injects it), so it is unit-testable
 * against a fake OTLP endpoint.
 */
export function createLatitudeExporter(config: LatitudeExporterConfig): SpanTreeExporter {
  const attrLimit = config.attributeValueLengthLimit ?? 8_192
  const resource = resourceFromAttributes({
    "service.name": config.serviceName ?? "teros-backend",
  })

  const otlp = new OTLPTraceExporter({
    url: config.url,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "X-Latitude-Project": config.project,
    },
    timeoutMillis: config.exportTimeoutMillis ?? 10_000,
  })
  const exporter = new CountingSpanExporter(otlp, config.hooks?.onExportResult)

  const processor = new BatchSpanProcessor(exporter, {
    maxExportBatchSize: config.maxExportBatchSize ?? 128,
    maxQueueSize: config.maxQueueSize ?? 1_024,
    scheduledDelayMillis: config.scheduledDelayMillis ?? 5_000,
    exportTimeoutMillis: config.exportTimeoutMillis ?? 10_000,
  })
  // Dedicated provider: isolation + a single ordered shutdown point. It does not
  // pipeline our manual spans (we call processor.onEnd directly) — see header.
  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [processor],
    spanLimits: { attributeValueLengthLimit: attrLimit },
  })

  return {
    export(spans: SpanDTO[]): void {
      config.hooks?.onEnqueue?.(spans.length)
      for (const dto of spans) {
        processor.onEnd(toReadableSpan(dto, resource, attrLimit))
      }
    },
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  }
}
