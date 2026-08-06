/**
 * Latitude webhook handler — `POST /webhooks/latitude` (F4 · C1).
 *
 * Receives Latitude "Agent Dispatch" deliveries (fired on `signal.discovered` /
 * `incident.opened`) and records a content-free `traceId → signal` projection so
 * the Session Trace can show a "known signal" badge. Verifies the HMAC SHA-256
 * signature in `X-Latitude-Signature` (`sha256=<hex>`, over the RAW body) against
 * `LATITUDE_WEBHOOK_SECRET`, fail-closed. Idempotent by `X-Latitude-Delivery`.
 *
 * Data minimisation (soberanía): the dispatch body ALSO carries `prompt`,
 * `sampleExcerpt`, and `sampleConversations[].excerpt` — message TEXT. Those are
 * NEVER read, stored, or logged here; only `signal.{slug,name,priority,source}`,
 * `deepLinkUrl`, and the 32-hex `sampleTraceIds` are extracted. The raw body is
 * never logged.
 *
 * Verified against the Latitude source (not its docs):
 *   packages/platform/agent-dispatch/src/adapters/webhook-adapter.ts (signing),
 *   packages/domain/agent-dispatch/src/entities/agent-dispatch-context.ts (shape).
 */

import { createHmac, timingSafeEqual } from "crypto"
import type { IncomingMessage, ServerResponse } from "http"
import type { Logger } from "pino"
import type { LatitudeSignalBadge, LatitudeSignalIndex } from "../services/latitude-signal-index.js"

/** Triggers we badge on. `manual` (a hand-fired dispatch) is ignored. */
const HANDLED_TRIGGERS = new Set(["signal.discovered", "incident.opened", "monitor.incident"])
const MAX_SAMPLE_TRACE_IDS = 5

interface ExtractedSignal {
  badge: LatitudeSignalBadge
  signalId: string
  traceIds: string[]
}

export class LatitudeWebhookHandler {
  constructor(
    private readonly index: LatitudeSignalIndex,
    private readonly secret: string,
    /** Latitude's public base URL; deep links are pinned to this host. */
    private readonly baseUrl: string | undefined,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async handleRoute(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    if (url !== "/webhooks/latitude") return false
    if (req.method !== "POST") {
      this.sendJson(res, 405, { error: "Method not allowed" })
      return true
    }
    await this.handle(req, res)
    return true
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await this.readRawBody(req)
    const signature = this.header(req, "x-latitude-signature")
    const deliveryId = this.header(req, "x-latitude-delivery")

    // Fail-closed: verify BEFORE parsing, over the raw bytes.
    if (!this.verifySignature(rawBody, signature)) {
      this.log.warn({ deliveryId }, "latitude webhook: invalid signature")
      this.sendJson(res, 401, { error: "Invalid signature" })
      return
    }
    if (!deliveryId) {
      this.sendJson(res, 400, { error: "Missing X-Latitude-Delivery" })
      return
    }

    let payload: unknown
    try {
      payload = JSON.parse(rawBody.toString("utf8"))
    } catch {
      this.sendJson(res, 400, { error: "Invalid JSON body" })
      return
    }

    // Ack fast; do the DB work on the tail. Never let Latitude's problems (or a
    // slow write) hold the delivery open. The body is never logged.
    this.sendJson(res, 200, { ok: true })
    setImmediate(() => {
      this.process(deliveryId, payload).catch((err) =>
        this.log.warn({ err, deliveryId }, "latitude webhook: processing failed"),
      )
    })
  }

  private async process(deliveryId: string, payload: unknown): Promise<void> {
    const now = this.now()
    if (!(await this.index.claimDelivery(deliveryId, now))) return // redelivery
    const extracted = this.extract(payload)
    if (!extracted) return
    await this.index.record(extracted.badge, extracted.signalId, extracted.traceIds, now)
  }

  /** Pull ONLY structural fields; every text field is left untouched. */
  private extract(payload: unknown): ExtractedSignal | null {
    const body = payload as { trigger?: unknown; context?: Record<string, unknown> }
    const ctx = body?.context
    if (!ctx || typeof ctx !== "object") return null

    const trigger = String(ctx.trigger ?? body.trigger ?? "")
    if (!HANDLED_TRIGGERS.has(trigger)) return null

    const signal = ctx.signal as Record<string, unknown> | undefined
    if (!signal || typeof signal.slug !== "string") return null

    const traceIds = Array.isArray(ctx.sampleTraceIds)
      ? ctx.sampleTraceIds.filter((t): t is string => typeof t === "string").slice(0, MAX_SAMPLE_TRACE_IDS)
      : []
    if (traceIds.length === 0) return null

    const slug = signal.slug
    const badge: LatitudeSignalBadge = {
      slug,
      name: typeof signal.name === "string" ? signal.name : slug,
      priority: typeof signal.priority === "string" ? signal.priority : null,
      source: typeof signal.source === "string" ? signal.source : "custom",
      deepLinkUrl: this.safeDeepLink(ctx.deepLinkUrl, slug),
      trigger,
    }
    return { badge, signalId: String(signal.id ?? slug), traceIds }
  }

  /**
   * Pin the deep link to Latitude's own host so a compromised/forged dispatch
   * can't turn the badge into an open redirect. If we know the base URL, rebuild
   * the link from it when the host doesn't match; otherwise accept only http(s).
   */
  private safeDeepLink(raw: unknown, slug: string): string {
    const fallback = this.baseUrl ? `${this.baseUrl.replace(/\/+$/, "")}/signals/${encodeURIComponent(slug)}` : ""
    if (typeof raw !== "string") return fallback
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return fallback
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallback
    if (this.baseUrl) {
      try {
        if (new URL(this.baseUrl).host !== parsed.host) return fallback
      } catch {
        /* baseUrl unparseable → fall through and trust the http(s) link */
      }
    }
    return raw
  }

  private verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader || !this.secret) return false
    const expected = `sha256=${createHmac("sha256", this.secret).update(rawBody).digest("hex")}`
    const a = Buffer.from(expected)
    const b = Buffer.from(signatureHeader)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  private header(req: IncomingMessage, name: string): string | undefined {
    const v = req.headers[name]
    return Array.isArray(v) ? v[0] : v
  }

  private readRawBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => resolve(Buffer.concat(chunks)))
      req.on("error", reject)
    })
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body))
  }
}
