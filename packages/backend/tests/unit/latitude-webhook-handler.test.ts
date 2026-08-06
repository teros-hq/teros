/**
 * Unit tests for the Latitude webhook handler (F4 · C1).
 *
 * Mutation-verified. The fake signs bodies with the SAME HMAC scheme the real
 * Latitude webhook-adapter uses (createHmac sha256 over the raw body →
 * `sha256=<hex>`), so a signature regression fails here. The content-minimisation
 * assertions pin that NO text field (prompt / sampleExcerpt / sampleConversations)
 * is ever forwarded to the index.
 */

import { createHmac } from "node:crypto"
import { Readable } from "node:stream"
import { describe, expect, it } from "bun:test"
import { LatitudeWebhookHandler } from "../../src/handlers/latitude-webhook-handler"
import type { LatitudeSignalBadge } from "../../src/services/latitude-signal-index"

const SECRET = "whsec_test_latitude"
const BASE_URL = "https://latitude.local"

const stubLogger = { warn: () => {}, info: () => {}, error: () => {} } as never

interface RecordCall {
  badge: LatitudeSignalBadge
  signalId: string
  traceIds: string[]
}

function fakeIndex() {
  const seen = new Set<string>()
  const records: RecordCall[] = []
  const index = {
    claimDelivery: async (id: string) => {
      if (seen.has(id)) return false
      seen.add(id)
      return true
    },
    record: async (badge: LatitudeSignalBadge, signalId: string, traceIds: string[]) => {
      records.push({ badge, signalId, traceIds })
    },
    // unused by the handler
    ensureIndexes: async () => {},
    lookupByTraceIds: async () => null,
  }
  return { index: index as never, records, seen }
}

function fakeReq(body: string, headers: Record<string, string>, method = "POST") {
  const req = Readable.from([Buffer.from(body, "utf8")]) as Readable & {
    headers: Record<string, string>
    method: string
  }
  req.headers = headers
  req.method = method
  return req as never
}

function fakeRes() {
  const out = { status: 0, body: "" }
  const res = {
    writeHead: (status: number) => {
      out.status = status
    },
    end: (body?: string) => {
      out.body = body ?? ""
    },
  }
  return { res: res as never, out }
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("hex")}`
}

/** A full "Agent Dispatch" body, INCLUDING the text fields we must drop. */
function dispatchBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    trigger: "signal.discovered",
    prompt: "SECRET PROMPT TEXT the LLM generated — must never be stored",
    context: {
      trigger: "signal.discovered",
      organizationName: "Acme",
      projectName: "Default",
      projectSlug: "default-project",
      signal: {
        id: "sig_123",
        slug: "custom-tool-calls-return-generic-tool-error",
        name: "Custom tool calls return generic tool_error",
        source: "custom",
        priority: "high",
      },
      deepLinkUrl: "https://latitude.local/signals/custom-tool-calls-return-generic-tool-error",
      sampleTraceIds: ["a".repeat(32), "b".repeat(32)],
      sampleExcerpt: "USER MESSAGE TEXT — must never be stored",
      sampleConversations: [{ traceId: "a".repeat(32), excerpt: "MORE USER TEXT — must never be stored" }],
      ...over,
    },
  })
}

const settle = () => new Promise((r) => setTimeout(r, 15))

function makeHandler(index: never) {
  return new LatitudeWebhookHandler(index, SECRET, BASE_URL, stubLogger, () => new Date(0))
}

describe("LatitudeWebhookHandler — HMAC + routing", () => {
  it("returns false for a non-matching url (lets other routes handle it)", async () => {
    const { index } = fakeIndex()
    const { res } = fakeRes()
    const handled = await makeHandler(index).handleRoute(fakeReq("", {}), res, "/metrics")
    expect(handled).toBe(false)
  })

  it("405s a non-POST to /webhooks/latitude", async () => {
    const { index } = fakeIndex()
    const { res, out } = fakeRes()
    await makeHandler(index).handleRoute(fakeReq("", {}, "GET"), res, "/webhooks/latitude")
    expect(out.status).toBe(405)
  })

  it("rejects a body with a WRONG signature (fail-closed 401, nothing recorded)", async () => {
    const { index, records } = fakeIndex()
    const { res, out } = fakeRes()
    const body = dispatchBody()
    await makeHandler(index).handleRoute(
      fakeReq(body, { "x-latitude-signature": "sha256=deadbeef", "x-latitude-delivery": "d1" }),
      res,
      "/webhooks/latitude",
    )
    await settle()
    expect(out.status).toBe(401)
    expect(records).toHaveLength(0)
  })

  it("rejects a MISSING signature (fail-closed 401)", async () => {
    const { index, records } = fakeIndex()
    const { res, out } = fakeRes()
    const body = dispatchBody()
    await makeHandler(index).handleRoute(
      fakeReq(body, { "x-latitude-delivery": "d1" }),
      res,
      "/webhooks/latitude",
    )
    await settle()
    expect(out.status).toBe(401)
    expect(records).toHaveLength(0)
  })
})

describe("LatitudeWebhookHandler — content minimisation + extraction", () => {
  it("records ONLY structural fields and NEVER any text", async () => {
    const { index, records } = fakeIndex()
    const { res, out } = fakeRes()
    const body = dispatchBody()
    await makeHandler(index).handleRoute(
      fakeReq(body, { "x-latitude-signature": sign(body), "x-latitude-delivery": "d1" }),
      res,
      "/webhooks/latitude",
    )
    await settle()

    expect(out.status).toBe(200)
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      badge: {
        slug: "custom-tool-calls-return-generic-tool-error",
        name: "Custom tool calls return generic tool_error",
        priority: "high",
        source: "custom",
        deepLinkUrl: "https://latitude.local/signals/custom-tool-calls-return-generic-tool-error",
        trigger: "signal.discovered",
      },
      signalId: "sig_123",
      traceIds: ["a".repeat(32), "b".repeat(32)],
    })
    // Belt-and-suspenders: no text leaked into what we stored.
    const serialized = JSON.stringify(records[0])
    expect(serialized.includes("SECRET PROMPT")).toBe(false)
    expect(serialized.includes("USER MESSAGE")).toBe(false)
    expect(serialized.includes("MORE USER TEXT")).toBe(false)
    expect(serialized.includes("excerpt")).toBe(false)
  })

  it("ignores a non-badge trigger (manual) — 200 but nothing recorded", async () => {
    const { index, records } = fakeIndex()
    const { res, out } = fakeRes()
    const body = dispatchBody({ trigger: "manual" })
    await makeHandler(index).handleRoute(
      fakeReq(body, { "x-latitude-signature": sign(body), "x-latitude-delivery": "d1" }),
      res,
      "/webhooks/latitude",
    )
    await settle()
    expect(out.status).toBe(200)
    expect(records).toHaveLength(0)
  })

  it("drops a dispatch with no sampleTraceIds (nothing to badge)", async () => {
    const { index, records } = fakeIndex()
    const { res } = fakeRes()
    const body = dispatchBody({ sampleTraceIds: [] })
    await makeHandler(index).handleRoute(
      fakeReq(body, { "x-latitude-signature": sign(body), "x-latitude-delivery": "d1" }),
      res,
      "/webhooks/latitude",
    )
    await settle()
    expect(records).toHaveLength(0)
  })

  it("caps sampleTraceIds at 5", async () => {
    const { index, records } = fakeIndex()
    const { res } = fakeRes()
    const many = Array.from({ length: 8 }, (_, i) => String(i).repeat(32))
    const body = dispatchBody({ sampleTraceIds: many })
    await makeHandler(index).handleRoute(
      fakeReq(body, { "x-latitude-signature": sign(body), "x-latitude-delivery": "d1" }),
      res,
      "/webhooks/latitude",
    )
    await settle()
    expect(records[0].traceIds).toHaveLength(5)
  })

  it("pins deepLinkUrl to Latitude's host — a foreign host is rewritten from baseUrl", async () => {
    const { index, records } = fakeIndex()
    const { res } = fakeRes()
    const body = dispatchBody({ deepLinkUrl: "https://evil.example.com/steal" })
    await makeHandler(index).handleRoute(
      fakeReq(body, { "x-latitude-signature": sign(body), "x-latitude-delivery": "d1" }),
      res,
      "/webhooks/latitude",
    )
    await settle()
    expect(records[0].badge.deepLinkUrl).toBe(
      "https://latitude.local/signals/custom-tool-calls-return-generic-tool-error",
    )
  })
})

describe("LatitudeWebhookHandler — idempotency", () => {
  it("records once for a redelivered X-Latitude-Delivery", async () => {
    const { index, records } = fakeIndex()
    const handler = makeHandler(index)
    const body = dispatchBody()
    const headers = { "x-latitude-signature": sign(body), "x-latitude-delivery": "dup-1" }
    for (let i = 0; i < 2; i++) {
      const { res } = fakeRes()
      await handler.handleRoute(fakeReq(body, headers), res, "/webhooks/latitude")
      await settle()
    }
    expect(records).toHaveLength(1)
  })
})
