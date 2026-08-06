/**
 * F3a — transport smoke (technical, not behavioral).
 *
 * Drives the REAL exporter (OTLP/HTTP + BatchSpanProcessor + dedicated provider)
 * against a throwaway local HTTP server standing in for the Latitude ingest, and
 * asserts the wire: a POST to /v1/traces with the Bearer + X-Latitude-Project
 * headers, carrying a well-formed OTLP body with the three spans and the
 * service.name resource. This is the transport/data smoke that is mine; the
 * behavioral E2E (a real turn landing in a self-hosted Latitude) is Antonio's.
 */

import { describe, expect, it } from "bun:test"
import { type Server, createServer } from "node:http"
import { createLatitudeExporter } from "../../src/services/otel-latitude-exporter"
import { buildSpanTree } from "../../src/services/otel-span-builder"
import type { AgentTurnTelemetry } from "../../src/services/session-trace-assembler"

const TURN: AgentTurnTelemetry = {
  session: {
    sessionUsageId: "usess_smoke",
    parentSessionUsageId: null,
    rootSessionUsageId: "usess_smoke",
    triggerKind: "user_message",
    userId: "u",
    agentId: "a",
    workspaceId: "w",
    channelId: "ch",
    provider: "teros",
    actualProvider: "fireworks",
    modelId: "kimi-k2",
    startedAt: new Date(1000),
    endedAt: new Date(5000),
    durationMs: 4000,
    status: "completed",
    llmCallCount: 1,
    toolCallCount: 1,
    costUsd: 0.02,
  },
  llmCalls: [
    {
      usageId: "usage_1",
      step: 0,
      provider: "teros",
      actualProvider: "fireworks",
      modelId: "kimi-k2",
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costTotal: 0.02,
      latencyMs: 800,
      finishReasons: ["stop"],
      messageId: "msg_1",
      timestamp: new Date(4000),
    },
  ],
  toolCalls: [
    {
      toolExecutionId: "tex_1",
      stepIndex: 0,
      toolCallIndex: 0,
      toolName: "search",
      mcaId: "mca.brave",
      status: "success",
      startedAt: new Date(2000),
      durationMs: 500,
    },
  ],
}

interface Captured {
  url?: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

describe("F3a transport smoke — real OTLP over HTTP", () => {
  it("POSTs a well-formed OTLP payload with auth headers to the ingest", async () => {
    let captured: Captured | null = null
    const server: Server = createServer((req, res) => {
      let data = ""
      req.on("data", (c) => {
        data += c
      })
      req.on("end", () => {
        captured = { url: req.url, headers: req.headers, body: data }
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end("{}")
      })
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port

    const exporter = createLatitudeExporter({
      url: `http://localhost:${port}/v1/traces`,
      token: "test-token",
      project: "teros-test",
    })

    exporter.export(buildSpanTree(TURN, {}, { includeContent: false }))
    await exporter.forceFlush()

    const deadline = Date.now() + 3000
    while (!captured && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    await exporter.shutdown()
    server.close()

    expect(captured).not.toBeNull()
    const c = captured as unknown as Captured
    expect(c.url).toBe("/v1/traces")
    expect(c.headers.authorization).toBe("Bearer test-token")
    expect(c.headers["x-latitude-project"]).toBe("teros-test")

    const parsed = JSON.parse(c.body)
    const spans = parsed.resourceSpans[0].scopeSpans[0].spans
    expect(spans).toHaveLength(3)
    expect(spans.map((s: { name: string }) => s.name).sort()).toEqual([
      "chat kimi-k2",
      "execute_tool search",
      "invoke_agent",
    ])
    const resourceAttrs = parsed.resourceSpans[0].resource.attributes
    expect(
      resourceAttrs.some(
        (a: { key: string; value: { stringValue?: string } }) =>
          a.key === "service.name" && a.value.stringValue === "teros-backend",
      ),
    ).toBe(true)
  })
})
